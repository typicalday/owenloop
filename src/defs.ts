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
import type { InputDef, JsonSchema, LoopDef, ProducePattern, WorkflowDef } from './types.ts';

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
  invalidates?: unknown;
  cadence?: unknown;
  maxRunsPerDay?: unknown;
  parallel?: unknown;
  maxAttempts?: unknown;
  maxSchemaFailures?: unknown;
  model?: unknown;
  workdir?: unknown;
  terminal?: unknown;
  body?: unknown;
}
interface RawDef {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputs?: unknown;
  loops?: unknown;
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
 * Schema the produced value must satisfy at commit time (§18).
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
  const loops: LoopDef[] = r.loops.map((rl, i) => buildLoop(rl as RawLoop, i));

  const def: WorkflowDef = { name, inputs, loops };
  if (r.title !== undefined) def.title = asString(r.title, 'title');
  if (r.description !== undefined) def.description = asString(r.description, 'description');
  return def;
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
  const name = asString(rl.name, `loops[${i}].name`);
  const consumes = asStringArray(rl.consumes, `loop '${name}'.consumes`).map(parseConsume);
  const produces = parseProduces(rl.produces, `loop '${name}'.produces`);
  const cadence = rl.cadence === undefined ? DEFAULTS.cadence : asString(rl.cadence, `loop '${name}'.cadence`);
  const loop: LoopDef = {
    name,
    consumes,
    produces,
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
 * explicitly intended sinks.
 */
function deadEndWarnings(def: WorkflowDef): string[] {
  // all stems consumed by any loop
  const consumed = new Set<string>(
    def.loops.flatMap((l) => l.consumes.map((c) => c.stem)),
  );

  const warnings: string[] = [];
  for (const l of def.loops) {
    if (l.terminal) continue; // terminal loops are intended sinks
    for (const p of l.produces) {
      if (p.kind === 'map') continue; // per-element outputs are not top-level stems
      if (!consumed.has(p.stem)) {
        warnings.push(
          `loop '${l.name}' produces '${p.stem}' but nothing consumes it (dead-end output; mark the loop terminal: true if this is an intended sink)`,
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
 */
export function loadDefs(dir: string): Map<string, WorkflowDef> {
  const out = new Map<string, WorkflowDef>();
  const add = (def: WorkflowDef): void => {
    if (out.has(def.name)) throw new DefError(`duplicate workflow name '${def.name}' under ${dir}`);
    out.set(def.name, def);
  };
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const wf = join(full, 'workflow.yaml');
      try {
        if (statSync(wf).isFile()) add(loadDefFile(wf));
      } catch {
        /* no workflow.yaml in this subdir — skip */
      }
    } else if (/\.ya?ml$/.test(entry) && entry !== 'workflow.yaml') {
      add(loadDefFile(full));
    }
  }
  return out;
}

/**
 * Like `loadDefs` but uses `buildDef` (not `parseDef`) so wiring errors are
 * returned in the lint result rather than thrown. Used by `oweflow lint`.
 * Silently skips files that fail shape-parsing (malformed YAML or bad types).
 */
export function loadDefsRaw(dir: string): Map<string, WorkflowDef> {
  const out = new Map<string, WorkflowDef>();
  const add = (def: WorkflowDef): void => {
    if (out.has(def.name)) throw new DefError(`duplicate workflow name '${def.name}' under ${dir}`);
    out.set(def.name, def);
  };
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const wf = join(full, 'workflow.yaml');
      try {
        if (statSync(wf).isFile()) {
          const text = readFileSync(wf, 'utf8');
          add(buildDef(parseYaml(text), basename(wf)));
        }
      } catch { /* no workflow.yaml or buildDef failed shape-check — skip */ }
    } else if (/\.ya?ml$/.test(entry) && entry !== 'workflow.yaml') {
      try {
        const text = readFileSync(full, 'utf8');
        add(buildDef(parseYaml(text), basename(full)));
      } catch { /* malformed YAML or shape error — skip */ }
    }
  }
  return out;
}
