/**
 * Workflow definition loading & validation.
 *
 * A workflow is authored as a single self-contained YAML file. The engine is
 * domain-neutral, so a definition is *just wiring*: declared inputs, plus a set
 * of loops connected by the artifacts they `consumes` / `produces`. This module
 * turns that YAML into a validated `WorkflowDef` — parsing the path patterns
 * (paths.ts), filling defaults, and rejecting mis-wired graphs (dangling
 * consumes, two writers for one artifact, map/reduce mismatches, dependency
 * cycles) *before* an instance is ever created.
 *
 *   name: delivery
 *   inputs:
 *     - name: proposal
 *   loops:
 *     - name: planner
 *       consumes: [proposal]
 *       produces: [plan]
 *       body: |
 *         Draft a plan for ${WORKFLOW}.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConsume, parseProduce } from './paths.ts';
import { parseDurationSecs } from './util.ts';
import { assertValidSchema } from './schema.ts';
import type { Acceptance, EffectDef, FiringTrigger, InputDef, InvariantDef, InvariantPredicate, JsonSchema, LoopDef, ProducePattern, WorkflowDef } from './types.ts';

// ---- raw (pre-validation) YAML shapes ---------------------------------------

interface RawInput {
  name?: unknown;
  producer?: unknown;
  seedOwed?: unknown;
  schema?: unknown;
}
/** A produce entry: either a bare `"plan"` string, or `{ name, schema }`. */
interface RawProduce {
  name?: unknown;
  schema?: unknown;
}
interface RawLoop {
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
  /** M2-GRAMMAR: if present, this entry is a calls: loop (Mode 2 runtime composition). */
  calls?: unknown;
}
/** Duck-typed sniffer for a raw calls: directive (Mode 2). */
interface RawCalls {
  name?: unknown;
  calls?: unknown;
  inputs?: unknown;
  produces?: unknown;
}
/** Duck-typed sniffer for a raw include directive. */
interface RawInclude {
  include?: unknown;
  as?: unknown;
  inputs?: unknown;
}
interface RawDef {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputs?: unknown;
  loops?: unknown;
  outputs?: unknown;
  invariants?: unknown;
}

// ---- defaults ----------------------------------------------------------------

const DEFAULTS = {
  cadence: '0s',
  maxRunsPerDay: 1000,
  parallel: 1,
  maxAttempts: 3,
  maxSchemaFailures: 5,
  workdir: 'main',
} as const;

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
 * Parse a loop's `produces` list. Each entry is either a bare pattern string
 * (`plan`, `gather.source[]`) or a mapping `{ name, schema }` attaching a JSON
 * Schema the produced value must satisfy at commit time (§19).
 */
function parseProduces(v: unknown, ctx: string): ProducePattern[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new DefError(`${ctx} must be a list`);
  return v.map((entry, i) => {
    if (typeof entry === 'string') return parseProduce(entry);
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const raw = entry as RawProduce;
      const name = asString(raw.name, `${ctx}[${i}].name`);
      const pat = parseProduce(name);
      if (raw.schema !== undefined) pat.schema = asSchema(raw.schema, `produce '${name}'.schema`);
      return pat;
    }
    throw new DefError(`${ctx}[${i}] must be a string or a { name, schema } mapping`);
  });
}

export class DefError extends Error {}

// ---- Mode 1 include-directive helpers (M1-GRAMMAR) ---------------------------

/** Duck-check: does this raw loop-list entry look like an include directive? */
function isIncludeDirective(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'include' in v;
}

/** Duck-check: does this raw loop-list entry look like a calls: directive (M2-GRAMMAR)? */
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
  // include: must be a non-empty string
  if (typeof obj.include !== 'string' || obj.include.trim() === '') {
    throw new DefError(`loop entry [${i}] 'include:' must be a workflow name string`);
  }
  const defName = obj.include.trim();
  // as: is required
  if (obj.as === undefined) {
    throw new DefError(`loop entry [${i}] include directive is missing 'as:'`);
  }
  // as: must be a string
  if (typeof obj.as !== 'string') {
    throw new DefError(`loop entry [${i}] include 'as:' must be a string`);
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
  'owed', 'green', 'rejected', 'retracted', 'skipped', 'present', 'absent',
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
 * malformed shapes (wrong types, missing name/loops). Use `parseDef` for the
 * full build-and-validate; this is exposed mainly so the validator can be
 * exercised on a built-but-invalid graph.
 */
export function buildDef(raw: unknown, source?: string): WorkflowDef {
  if (typeof raw !== 'object' || raw === null) {
    throw new DefError(`workflow definition${source ? ` (${source})` : ''} must be a mapping`);
  }
  const r = raw as RawDef;
  const name = asString(r.name, 'name');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new DefError(`workflow name '${name}' must be alphanumeric (with - or _)`);
  }

  const inputs: InputDef[] = (Array.isArray(r.inputs) ? r.inputs : []).map((ri, i) => {
    const raw = ri as RawInput;
    const inName = asString(raw.name, `inputs[${i}].name`);
    const input: InputDef = {
      name: inName,
      producer: raw.producer === undefined ? 'human' : asString(raw.producer, `inputs[${i}].producer`),
      seedOwed: asBool(raw.seedOwed, false, `inputs[${i}].seedOwed`),
    };
    if (raw.schema !== undefined) input.schema = asSchema(raw.schema, `input '${inName}'.schema`);
    return input;
  });

  if (!Array.isArray(r.loops) || r.loops.length === 0) {
    throw new DefError(`workflow '${name}' must declare at least one loop`);
  }

  // Parse the loop list, splitting normal loops from include directives (M1-GRAMMAR).
  const includes: NonNullable<WorkflowDef['_includes']> = [];
  const loops: LoopDef[] = [];
  for (const [i, rl] of (r.loops as unknown[]).entries()) {
    if (isIncludeDirective(rl)) {
      const inc = parseIncludeDirective(rl, i, name);
      includes.push({ pos: loops.length, ...inc });
    } else {
      loops.push(buildLoop(rl as RawLoop, i));
    }
  }

  // M1-GRAMMAR post-parse cross-checks: duplicate as: and as:/loop-name collision.
  if (includes.length > 0) {
    const asSeen = new Set<string>();
    const loopNameSet = new Set(loops.map((l) => l.name));
    for (const inc of includes) {
      if (asSeen.has(inc.as)) {
        throw new DefError(`include 'as:' value '${inc.as}' is used more than once in workflow '${name}'`);
      }
      asSeen.add(inc.as);
      if (loopNameSet.has(inc.as)) {
        throw new DefError(`include 'as:' value '${inc.as}' collides with sibling loop name '${inc.as}' in workflow '${name}'`);
      }
    }
  }

  // Require at least one loop OR at least one include directive.
  // (The loops array above may be empty if ALL entries are includes — that is fine
  //  once expanded. But we still need the workflow to have some work.)

  const def: WorkflowDef = { name, inputs, loops };
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
 * Prefix all names/stems in a LoopDef with `${prefix}.`. Pure — returns a new LoopDef.
 * Rewrites: loop name, consume stems, produce stems, generates stems, invalidates, and
 * effect.onInvalidate loop-name strings (but not 'pin'/'escalate').
 */
function prefixLoop(loop: LoopDef, prefix: string): LoopDef {
  const prefixStem = (stem: string): string => `${prefix}.${stem}`;

  const newConsumes = loop.consumes.map((c) => {
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

  const newProduces = loop.produces.map(prefixProduce);
  const newGenerates = loop.generates ? loop.generates.map(prefixProduce) : undefined;

  const newInvalidates = loop.invalidates.map(prefixStem);

  let newEffect = loop.effect;
  if (loop.effect?.onInvalidate && loop.effect.onInvalidate !== 'pin' && loop.effect.onInvalidate !== 'escalate') {
    newEffect = { ...loop.effect, onInvalidate: prefixStem(loop.effect.onInvalidate) };
  }

  const result: LoopDef = {
    ...loop,
    name: prefixStem(loop.name),
    consumes: newConsumes,
    produces: newProduces,
    invalidates: newInvalidates,
  };
  if (newGenerates !== undefined) result.generates = newGenerates;
  if (newEffect !== undefined) result.effect = newEffect;
  return result;
}

/**
 * Expand all `_includes` directives in a `WorkflowDef`, returning a new def with
 * the child loops spliced in (prefixed + inputs rewired). Pure — never mutates input.
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

  // Build the ordered slot list: interleave normal loops and include directives by pos.
  // Each include has a `pos` = index in the original loops array where it is inserted.
  // We reconstruct the full ordered list in a single pass.
  const sortedIncludes = [...def._includes].sort((a, b) => a.pos - b.pos);

  const resultLoops: LoopDef[] = [];
  const resultInputs: import('./types.ts').InputDef[] = [...def.inputs];
  const resultOutputs: string[] = [...(def.outputs ?? [])];

  // Walk the original loops interspersed with includes.
  let loopIdx = 0;
  let incIdx = 0;

  while (loopIdx < def.loops.length || incIdx < sortedIncludes.length) {
    // Emit all include directives whose pos <= current loop index.
    while (incIdx < sortedIncludes.length && sortedIncludes[incIdx]!.pos <= loopIdx) {
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

      // (e) prefix child loops
      const prefixedLoops = child.loops.map((l) => prefixLoop(l, inc.as));

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

      // Apply input rewrites to prefixed loops
      const rewrittenLoops = prefixedLoops.map((l) => {
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

      resultLoops.push(...rewrittenLoops);

      // (g) merge child outputs
      for (const stem of child.outputs ?? []) {
        const prefixedStem = `${inc.as}.${stem}`;
        if (!resultOutputs.includes(prefixedStem)) {
          resultOutputs.push(prefixedStem);
        }
      }
    }

    // Emit the next normal loop (if any remain)
    if (loopIdx < def.loops.length) {
      resultLoops.push(def.loops[loopIdx]!);
      loopIdx++;
    }
  }

  return {
    ...def,
    loops: resultLoops,
    inputs: resultInputs,
    outputs: resultOutputs.length > 0 ? resultOutputs : def.outputs,
    _includes: undefined,
  };
}

/** Build a validated `WorkflowDef` from a parsed YAML object (or throw DefError). */
export function parseDef(raw: unknown, source?: string): WorkflowDef {
  const def = buildDef(raw, source);
  const errors = validateDef(def);
  if (errors.length) {
    throw new DefError(
      `invalid workflow '${def.name}'${source ? ` (${source})` : ''}:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return def;
}

function buildLoop(rl: RawLoop, i: number): LoopDef {
  // M2-GRAMMAR: if this entry carries a 'calls' key, parse it as a calls: loop (Mode 2).
  if (typeof rl.calls !== 'undefined') {
    const rawCalls = rl as RawCalls;
    const name = asString(rawCalls.name, `loops[${i}].name`);
    const callsTarget = asString(rawCalls.calls, `loop '${name}'.calls`);
    // parse inputs: optional mapping of child input name -> parent artifact name
    const callsInputs: Record<string, string> = {};
    if (rawCalls.inputs !== undefined) {
      if (typeof rawCalls.inputs !== 'object' || rawCalls.inputs === null || Array.isArray(rawCalls.inputs)) {
        throw new DefError(`loop '${name}'.inputs: must be an object mapping child input names to parent artifact names`);
      }
      for (const [k, v] of Object.entries(rawCalls.inputs as Record<string, unknown>)) {
        if (typeof v !== 'string') throw new DefError(`loop '${name}'.inputs: value for key '${k}' must be a string`);
        callsInputs[k] = v;
      }
    }
    // parse produces: (required; exactly one — enforced by validateDef)
    const producesPatterns = parseProduces(rawCalls.produces, `loop '${name}'.produces`);
    const loop: LoopDef = {
      name,
      calls: callsTarget,
      callsInputs,
      consumes: [],          // calls: loops have no consumes in LoopDef (eligibility is engine-managed)
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
    return loop;
  }

  const name = asString(rl.name, `loops[${i}].name`);
  const consumes = asStringArray(rl.consumes, `loop '${name}'.consumes`).map(parseConsume);
  const producesPatterns = parseProduces(rl.produces, `loop '${name}'.produces`);
  const generatesPatterns = parseProduces(rl.generates, `loop '${name}'.generates`);
  const cadence = rl.cadence === undefined ? DEFAULTS.cadence : asString(rl.cadence, `loop '${name}'.cadence`);
  const loop: LoopDef = {
    name,
    consumes,
    produces: [...producesPatterns, ...generatesPatterns], // engine reads this unified array
    invalidates: rl.invalidates === undefined
      ? consumes.map((c) => c.stem)
      : asStringArray(rl.invalidates, `loop '${name}'.invalidates`),
    cadence,
    cadenceSecs: parseDurationSecs(cadence),
    maxRunsPerDay: asNumber(rl.maxRunsPerDay, DEFAULTS.maxRunsPerDay, `loop '${name}'.maxRunsPerDay`),
    parallel: asNumber(rl.parallel, DEFAULTS.parallel, `loop '${name}'.parallel`),
    maxAttempts: asNumber(rl.maxAttempts, DEFAULTS.maxAttempts, `loop '${name}'.maxAttempts`),
    maxSchemaFailures: asNumber(rl.maxSchemaFailures, DEFAULTS.maxSchemaFailures, `loop '${name}'.maxSchemaFailures`),
    workdir: rl.workdir === undefined ? DEFAULTS.workdir : asString(rl.workdir, `loop '${name}'.workdir`),
    body: rl.body === undefined ? '' : asString(rl.body, `loop '${name}'.body`),
  };
  if (rl.model !== undefined) loop.model = asString(rl.model, `loop '${name}'.model`);
  if (asBool(rl.terminal, false, `loop '${name}'.terminal`)) loop.terminal = true;
  if (generatesPatterns.length > 0) loop.generates = generatesPatterns; // kept for lint only
  if (rl.effect !== undefined) {
    if (typeof rl.effect !== 'object' || rl.effect === null || Array.isArray(rl.effect)) {
      throw new DefError(`loop '${name}'.effect must be an object`);
    }
    const rawEffect = rl.effect as Record<string, unknown>;
    const effectDef: EffectDef = {};
    if (rawEffect['idempotent'] !== undefined) {
      effectDef.idempotent = asBool(rawEffect['idempotent'], true, `loop '${name}'.effect.idempotent`);
    }
    if (rawEffect['onInvalidate'] !== undefined) {
      const oi = asString(rawEffect['onInvalidate'], `loop '${name}'.effect.onInvalidate`);
      effectDef.onInvalidate = oi; // any string accepted here; D-D checks in validateDef
    }
    loop.effect = effectDef;
  }
  if (rl.on !== undefined) {
    const rawOn = asStringArray(rl.on, `loop '${name}'.on`);
    if (rawOn.length === 0) {
      throw new DefError(`loop '${name}'.on must not be empty; a loop must have at least one firing trigger`);
    }
    for (const tok of rawOn) {
      if (tok !== 'inputsGreen' && tok !== 'allGreen' && tok !== 'idle') {
        throw new DefError(
          `loop '${name}': on: token '${tok}' is not supported; supported: 'inputsGreen', 'allGreen', 'idle'`,
        );
      }
    }
    loop.on = rawOn as FiringTrigger[];
  }
  if (rl.idleAfter !== undefined) {
    const idleAfterStr = asString(rl.idleAfter, `loop '${name}'.idleAfter`);
    loop.idleAfter = idleAfterStr;
    loop.idleAfterMs = parseDurationSecs(idleAfterStr) * 1000;
  }
  return loop;
}

// ---- validation --------------------------------------------------------------

/**
 * Static wiring checks over a built definition. Returns human-readable error
 * strings (empty = valid). Catches the mistakes that would otherwise surface as
 * a workflow that never settles or never makes progress.
 */
export function validateDef(def: WorkflowDef): string[] {
  const errors: string[] = [];

  // unique loop names
  const loopNames = new Set<string>();
  for (const l of def.loops) {
    if (loopNames.has(l.name)) errors.push(`duplicate loop name '${l.name}'`);
    loopNames.add(l.name);
  }

  // an input name may not collide with a loop name or a produced artifact
  const inputNames = new Set(def.inputs.map((i) => i.name));
  for (const dup of [...inputNames].filter((n) => loopNames.has(n))) {
    errors.push(`'${dup}' is both an input and a loop name`);
  }

  // one writer per artifact: map produced singleton/collection stems to producers
  const producerOf = new Map<string, string>(); // stem -> loop name
  const collectionStems = new Set<string>();
  for (const name of inputNames) producerOf.set(name, 'human');
  for (const l of def.loops) {
    // a loop must consume in exactly one mode (plain-only, or one map, or one reduce)
    const maps = l.consumes.filter((c) => c.mode === 'map');
    const reduces = l.consumes.filter((c) => c.mode === 'reduce');
    if (maps.length > 1) errors.push(`loop '${l.name}' has more than one map consume`);
    if (reduces.length > 1) errors.push(`loop '${l.name}' has more than one reduce consume`);
    if (maps.length && reduces.length) {
      errors.push(`loop '${l.name}' mixes a map and a reduce consume (pick one shape)`);
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

    // map/reduce loops must produce the matching output shape
    if (maps.length && !l.produces.some((p) => p.kind === 'map')) {
      errors.push(`loop '${l.name}' maps an element but produces no per-element (\$i) output`);
    }
    if (l.produces.some((p) => p.kind === 'map') && !maps.length) {
      errors.push(`loop '${l.name}' produces a per-element output but has no map (\$i) consume to bind it`);
    }
  }

  // same stem in both produces: and generates: on the same loop is a hard error
  for (const l of def.loops) {
    if (!l.generates || l.generates.length === 0) continue;
    const generatedStems = new Set(l.generates.map((p) => p.stem));
    // produces-only patterns are those NOT in generates (using object identity since generates
    // patterns are the same ProducePattern objects we unioned into produces)
    const producesOnly = l.produces.filter((p) => !l.generates!.includes(p));
    for (const p of producesOnly) {
      if (generatedStems.has(p.stem)) {
        errors.push(`loop '${l.name}': stem '${p.stem}' appears in both produces: and generates: (remove it from one)`);
      }
    }
  }

  // outputs: entries must name stems produced by some loop
  if (def.outputs && def.outputs.length > 0) {
    const allProducedStems = new Set<string>(
      def.loops.flatMap((l) => l.produces.map((p) => p.stem)),
    );
    for (const stem of def.outputs) {
      if (!allProducedStems.has(stem)) {
        errors.push(`outputs: entry '${stem}' is not produced by any loop`);
      }
    }
  }

  // every consumed stem must have a producer (an input or a loop output)
  for (const l of def.loops) {
    for (const c of l.consumes) {
      if (c.mode === 'plain') {
        if (!producerOf.has(c.stem)) {
          errors.push(`loop '${l.name}' consumes '${c.raw}' but nothing produces '${c.stem}'`);
        }
      } else {
        // map/reduce: the stem must be a collection produced somewhere
        if (!collectionStems.has(c.stem)) {
          errors.push(`loop '${l.name}' consumes collection '${c.raw}' but no loop produces '${c.stem}[]'`);
        }
      }
    }
  }

  // Collect loops already reported as dangling-consume (to avoid double-report
  // with the reachability check below, which catches the subtler case of a
  // producer that exists but is itself unreachable).
  const danglingLoops = new Set<string>();
  for (const l of def.loops) {
    for (const c of l.consumes) {
      if (c.mode === 'plain' && !producerOf.has(c.stem)) {
        danglingLoops.add(l.name);
      } else if (c.mode !== 'plain' && !collectionStems.has(c.stem)) {
        danglingLoops.add(l.name);
      }
    }
  }
  errors.push(...reachabilityErrors(def, danglingLoops));

  errors.push(...detectCycles(def, producerOf, collectionStems));

  // effect: validation
  for (const l of def.loops) {
    if (!l.effect) continue;
    // terminal: true and effect: are mutually exclusive (effect: is the forward spelling)
    if (l.terminal && l.effect) {
      errors.push(
        `loop '${l.name}': terminal: true and effect: are mutually exclusive; ` +
        `effect: is the forward spelling — remove terminal: true`,
      );
    }
    // onInvalidate validation (D-D cross-reference checks for named-handler strings)
    const oi = l.effect.onInvalidate;
    if (oi !== undefined && oi !== 'pin' && oi !== 'escalate') {
      // Named handler: cross-reference checks
      const handlerLoop = def.loops.find((h) => h.name === oi);
      if (!handlerLoop) {
        errors.push(`loop '${l.name}': effect.onInvalidate '${oi}' names a loop that does not exist in this workflow`);
      } else if (oi === l.name) {
        errors.push(`loop '${l.name}': effect.onInvalidate '${oi}' names itself; a loop cannot be its own handler`);
      } else if (handlerLoop.produces.length === 0) {
        errors.push(`loop '${l.name}': effect.onInvalidate handler '${oi}' produces no outputs; a handler must produce at least one output`);
      }
    }
  }

  // on: token validation — belt-and-suspenders over buildLoop's throw
  for (const l of def.loops) {
    if (!l.on) continue;
    if (l.on.length === 0) {
      errors.push(`loop '${l.name}': on: must not be empty; a loop must have at least one firing trigger`);
    }
    for (const tok of l.on) {
      if (tok !== 'inputsGreen' && tok !== 'allGreen' && tok !== 'idle') {
        errors.push(
          `loop '${l.name}': on: token '${tok}' is not supported; ` +
          `supported: 'inputsGreen', 'allGreen', 'idle'.`,
        );
      }
    }
  }

  // idle/idleAfter cross-checks
  for (const l of def.loops) {
    const hasIdle = l.on?.includes('idle') ?? false;
    if (hasIdle && l.idleAfterMs === undefined) {
      errors.push(`loop '${l.name}': on: includes 'idle' but idleAfter is not set; idleAfter is required for the idle trigger`);
    }
    if (!hasIdle && l.idleAfterMs !== undefined) {
      errors.push(`loop '${l.name}': idleAfter is set but 'idle' is not in on:; idleAfter is only meaningful with the idle trigger`);
    }
  }

  // M2-VALIDATE: calls: loop per-def rules.
  // Note: cross-def checks (target-def existence, child input-key validity) cannot be done here
  // because validateDef is a pure per-def function with no resolver. Those checks live in loadDefs
  // Phase 2, analogous to how expandIncludes validates include input-key mappings.
  for (const l of def.loops) {
    if (!l.calls) continue;
    // (a) calls: loop must produce exactly one output (one child, one outcome path — v1)
    if (l.produces.length !== 1) {
      errors.push(`calls: loop '${l.name}' must produce exactly one output (got ${l.produces.length})`);
    }
    // (b) callsInputs VALUES must be real parent artifacts (inputs or loop-produced stems)
    for (const [, parentArtifact] of Object.entries(l.callsInputs ?? {})) {
      if (!producerOf.has(parentArtifact)) {
        errors.push(
          `calls: loop '${l.name}' maps to parent artifact '${parentArtifact}' which is not produced by any loop or input`,
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

function register(map: Map<string, string>, stem: string, loop: string, errors: string[]): void {
  const existing = map.get(stem);
  if (existing && existing !== loop) {
    errors.push(`artifact '${stem}' has two producers: '${existing}' and '${loop}'`);
  }
  map.set(stem, loop);
}

/** Detect a dependency cycle in the consume→produce graph (a deadlock). */
function detectCycles(
  def: WorkflowDef,
  producerOf: Map<string, string>,
  collectionStems: Set<string>,
): string[] {
  // edges: loop -> producer-of-each-consumed-stem (excluding human inputs)
  const deps = new Map<string, Set<string>>();
  for (const l of def.loops) deps.set(l.name, new Set());
  for (const l of def.loops) {
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
 * loop that can never fire because one of its consumed stems is not transitively
 * reachable from the workflow inputs, even though a producer exists (a dead
 * island). Does NOT double-report when a dangling-consume error already fired
 * for the same loop (caller passes `danglingLoops` to suppress).
 */
function reachabilityErrors(
  def: WorkflowDef,
  danglingLoops: Set<string>,
): string[] {
  const reachable = new Set<string>(def.inputs.map((i) => i.name));
  const reachedLoop = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const l of def.loops) {
      if (reachedLoop.has(l.name)) continue;
      const allReachable = l.consumes.every((c) => reachable.has(c.stem));
      if (allReachable) {
        reachedLoop.add(l.name);
        changed = true;
        for (const p of l.produces) {
          reachable.add(p.stem);
        }
      }
    }
  }

  const errors: string[] = [];
  for (const l of def.loops) {
    if (reachedLoop.has(l.name)) continue;
    if (danglingLoops.has(l.name)) continue; // already reported as dangling-consume
    // find the first unreachable consumed stem
    const blocker = l.consumes.find((c) => !reachable.has(c.stem));
    const stem = blocker?.stem ?? '(unknown)';
    errors.push(
      `loop '${l.name}' is unreachable: it can never fire (consumes '${stem}' which nothing reachable produces)`,
    );
  }
  return errors;
}

/**
 * Returns warning strings for any singleton or collection stem that nothing
 * consumes, on a non-terminal loop. Map outputs are excluded (they are
 * per-element children, not consumed as top-level stems). Terminal loops are
 * explicitly intended sinks. Stems declared under generates: are exempt.
 */
function deadEndWarnings(def: WorkflowDef): string[] {
  // all stems consumed by any loop
  const consumed = new Set<string>(
    def.loops.flatMap((l) => l.consumes.map((c) => c.stem)),
  );
  // stems declared under generates: are intentionally unconsumed — lint-exempt
  const generatedStems = new Set<string>(
    def.loops.flatMap((l) => (l.generates ?? []).map((p) => p.stem)),
  );
  // stems declared in workflow outputs: are intentional public leaves — lint-exempt
  const workflowOutputStems = new Set<string>(def.outputs ?? []);

  const warnings: string[] = [];
  for (const l of def.loops) {
    if (l.terminal) continue; // terminal loops are intended sinks
    for (const p of l.produces) {
      if (p.kind === 'map') continue; // per-element outputs are not top-level stems
      if (generatedStems.has(p.stem)) continue; // generates: exempt
      if (workflowOutputStems.has(p.stem)) continue; // workflow outputs: exempt
      if (!consumed.has(p.stem)) {
        warnings.push(
          `loop '${l.name}' produces '${p.stem}' but nothing consumes it ` +
          `(dead-end output; declare it under generates: if no consumer is expected, ` +
          `list it in the workflow outputs: if it is a public interface leaf, ` +
          `or mark the loop terminal: true if this is an intended sink)`,
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
    // Unique calls: edges from this def (multiple loops might call the same child)
    const callsEdges = new Set((def?.loops ?? []).filter((l) => l.calls).map((l) => l.calls!));
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
  const def = parseDef(raw, basename(file));
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
          addRaw(buildDef(parseYaml(text), basename(wf)), wf);
        }
      } catch (e) {
        if (e instanceof DefError) throw e;
        /* no workflow.yaml in this subdir — skip */
      }
    } else if (/\.ya?ml$/.test(entry) && entry !== 'workflow.yaml') {
      const text = readFileSync(full, 'utf8');
      addRaw(buildDef(parseYaml(text), basename(full)), full);
    }
  }

  // Phase 2: expand includes, run per-def validation, and cross-def calls: checks.
  const out = new Map<string, WorkflowDef>();
  const resolver = (name: string): WorkflowDef | undefined => raw.get(name);
  for (const [name, def] of raw) {
    const expanded = expandIncludes(def, resolver);

    // M2-VALIDATE cross-def: target-def existence + child input-key validity.
    // These cannot live in validateDef (pure per-def, no resolver) — same split as expandIncludes.
    for (const l of expanded.loops) {
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
 * returned in the lint result rather than thrown. Used by `liveloop lint`.
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
          const def = buildDef(parseYaml(text), basename(wf));
          def.dir = wf;
          if (!raw.has(def.name)) raw.set(def.name, def);
        }
      } catch { /* no workflow.yaml or buildDef failed shape-check — skip */ }
    } else if (/\.ya?ml$/.test(entry) && entry !== 'workflow.yaml') {
      try {
        const text = readFileSync(full, 'utf8');
        const def = buildDef(parseYaml(text), basename(full));
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
