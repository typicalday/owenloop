/**
 * Reference-mode order resolution (WP-B1).
 *
 * Orders are REFERENCE packets: they carry a `defDigest` identifying the
 * pinned definition snapshot that emitted them, plus routing fields
 * (`workflow`/`step`/`key`/...), the dynamic `consumes` values, and the
 * dynamic `owes` feedback — but NEVER the authored static instruction bytes
 * (the prompt body, the command string, or static acceptance text).
 *
 * This module is the one boundary that turns a reference back into static
 * instructions: `(defDigest, step, key)` → the exact authored bytes
 * `{ prompt?, command?, acceptance? }`. The CLI and the embedded/library path
 * use the SAME resolver implementation — there is no second, local-only
 * resolution path and no verify-mode branch. An unknown digest is a named
 * refusal ({@link UnknownDefDigestError}) thrown before any caller can
 * execute a prompt or command; there is no fallback to definition-name
 * lookup and no empty-instructions return for an unknown digest.
 *
 * Scope (WP-B1): the adapter implemented here resolves over LOADED,
 * validated `WorkflowDef` objects — a temporary stand-in for the
 * content-addressed store that WP-A3 owns. The seam is deliberately narrow
 * ({@link OrderInstructionSource}) so a WP-A3-compatible source can be
 * injected later without changing the `Order` shape or its callers.
 */

import { createHash } from 'node:crypto';
import type { Order, StepDef, WorkflowDef } from './types.ts';

/** A reference to a step's static instructions inside a pinned definition. */
export interface OrderInstructionRef {
  /** Identity of the definition snapshot that emitted the order. */
  defDigest: string;
  /** The step name (synthesized judge step names resolve too — they are ordinary StepDefs in the compiled snapshot). */
  step: string;
  /** The binding key: '' for plain/reduce/collection steps, the element path for map elements. */
  key: string;
}

/**
 * The exact authored instruction bytes for one `(defDigest, step, key)`
 * reference. Every field is optional because the source may not carry each:
 * a command step has no agent prompt body semantics the other way around,
 * and the current engine grammar has no standalone authored acceptance —
 * only an injected WP-A3-compatible source or a verified fixture supplies
 * `acceptance`. The resolver returns the authored bytes UNTRANSFORMED: no
 * trimming, no newline normalization, no YAML re-serialization. It never
 * fabricates a value that is absent.
 */
export interface ResolvedInstructions {
  /** The authored prompt body bytes, exactly as authored. */
  prompt?: string;
  /** The authored command string bytes, exactly as authored. */
  command?: string;
  /** Optional static, source-owned acceptance instruction bytes. Never derived from the artifact lifecycle state. */
  acceptance?: string;
}

/**
 * The narrow digest/instruction source seam. WP-B1 ships the loaded-definition
 * adapter ({@link createDefInstructionSource}); WP-A3 can later inject an
 * implementation backed by its content-addressed store (canonical bundle
 * digests and verified instructions) without touching the engine's order
 * shape or callers.
 */
export interface OrderInstructionSource {
  /**
   * The identity digest for a loaded definition. Called by `buildOrder` for
   * the exact pinned snapshot it emits against; the adapter registers that
   * snapshot under the returned digest as a side effect, so the order stays
   * resolvable after the live definition map changes.
   */
  digestOf(def: WorkflowDef): string;
  /**
   * Resolve one reference to its exact instruction bytes, or return
   * `undefined` when no verified record exists for `(ref.defDigest,
   * ref.step)` — the caller turns `undefined` into the named refusal. The
   * `key` participates in identity (map elements are distinct bindings of
   * the same step) but the authored bytes are per step: a source may ignore
   * it when its storage is per-step.
   */
  lookup(ref: OrderInstructionRef): ResolvedInstructions | undefined;
  /**
   * Optional authored step access for materialization defaults (e.g. the
   * `${MAX_ATTEMPTS}` step default). Purely informational — resolution and
   * the named refusal depend only on `lookup`. Absent when a source keeps
   * instructions but not the surrounding step shape.
   */
  stepDef?(ref: OrderInstructionRef): StepDef | undefined;
}

/**
 * The named refusal for an unresolvable digest: thrown at the resolver
 * boundary when no verified definition/instruction record exists for the
 * digest, before any caller can execute an agent prompt or command. Carries
 * the rejected digest on the instance and names it in the message. Never
 * falls back to name lookup and never returns empty instructions instead.
 */
export class UnknownDefDigestError extends Error {
  override readonly name = 'UnknownDefDigestError';
  readonly defDigest: string;

  constructor(defDigest: string) {
    super(`unknown defDigest '${defDigest}' — no verified definition/instruction record exists for this digest; refusing to resolve instructions`);
    this.defDigest = defDigest;
  }
}

/**
 * Digest a compiled definition's instruction-bearing content. This is the
 * WP-B1 FALLBACK identity: a full (untruncated) sha256 over a canonical JSON
 * projection of exactly the fields an order's resolution depends on —
 * `name`, `engine`, `inputs`, `outputs`, `invariants`, `x`, `executors`,
 * and every step's authored instruction/routing fields. Deliberately
 * EXCLUDED: the source-location-only metadata `WorkflowDef.dir` (identical
 * content loaded from a different directory keeps the same identity) and the
 * `@internal` `_includes` (always absent on a fully-expanded def anyway).
 *
 * This is NOT hashDef's 16-hex accidental-drift hash, and it is not an
 * adversarial trust claim — WP-A3's content-addressed store replaces it with
 * canonical bundle digests through the same {@link OrderInstructionSource}
 * seam. The projection is stable: JSON.stringify preserves insertion order,
 * and buildDef/loadDefFile build fields in one deterministic order.
 */
export function defInstructionDigest(def: WorkflowDef): string {
  const stepProjection = (s: StepDef) => ({
    name: s.name,
    consumes: s.consumes.map((c) => c.raw),
    produces: s.produces.map((p) => p.raw),
    ...(s.generates !== undefined ? { generates: s.generates.map((g) => g.raw) } : {}),
    invalidates: s.invalidates,
    cadence: s.cadence,
    maxRunsPerDay: s.maxRunsPerDay,
    parallel: s.parallel,
    maxAttempts: s.maxAttempts,
    maxSchemaFailures: s.maxSchemaFailures,
    ...(s.model !== undefined ? { model: s.model } : {}),
    ...(s.executor !== undefined ? { executor: s.executor } : {}),
    ...(s.command !== undefined ? { command: s.command } : {}),
    ...(s.spec !== undefined ? { spec: s.spec } : {}),
    ...(s.workdir !== undefined ? { workdir: s.workdir } : {}),
    ...(s.terminal !== undefined ? { terminal: s.terminal } : {}),
    ...(s.effect !== undefined ? { effect: s.effect } : {}),
    ...(s.on !== undefined ? { on: s.on } : {}),
    ...(s.idleAfterMs !== undefined ? { idleAfterMs: s.idleAfterMs } : {}),
    ...(s.reapTtlMs !== undefined ? { reapTtlMs: s.reapTtlMs } : {}),
    ...(s.capabilities !== undefined ? { capabilities: s.capabilities } : {}),
    ...(s.maxLeaseMs !== undefined ? { maxLeaseMs: s.maxLeaseMs } : {}),
    ...(s.calls !== undefined ? { calls: s.calls } : {}),
    ...(s.callsInputs !== undefined ? { callsInputs: s.callsInputs } : {}),
    ...(s.judges !== undefined ? { judges: s.judges } : {}),
    ...(s.groups !== undefined ? { groups: s.groups } : {}),
    ...(s.x !== undefined ? { x: s.x } : {}),
    body: s.body,
  });
  const projection = {
    name: def.name,
    engine: def.engine,
    inputs: def.inputs,
    ...(def.outputs !== undefined ? { outputs: def.outputs } : {}),
    ...(def.invariants !== undefined ? { invariants: def.invariants } : {}),
    ...(def.x !== undefined ? { x: def.x } : {}),
    ...(def.executors !== undefined ? { executors: def.executors } : {}),
    steps: def.steps.map(stepProjection),
  };
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

/**
 * Create the WP-B1 loaded-definition adapter: an in-memory
 * {@link OrderInstructionSource} over validated `WorkflowDef` objects. Not a
 * content-addressed store — a temporary implementation of the seam that a
 * WP-A3 source replaces by injection. Definitions are indexed by digest on
 * demand: {@link OrderInstructionSource.digestOf} registers the exact
 * snapshot it digested, and `add` registers every seed def up front, so a
 * seeded source can resolve orders without `buildOrder` ever touching it
 * (e.g. injected-source tests).
 */
export function createDefInstructionSource(seeds?: Iterable<WorkflowDef>): OrderInstructionSource {
  const byDigest = new Map<string, WorkflowDef>();
  const register = (def: WorkflowDef): string => {
    const digest = defInstructionDigest(def);
    byDigest.set(digest, def);
    return digest;
  };
  if (seeds !== undefined) for (const def of seeds) register(def);
  const findStep = (ref: OrderInstructionRef): StepDef | undefined => {
    const def = byDigest.get(ref.defDigest);
    return def?.steps.find((s) => s.name === ref.step);
  };
  return {
    digestOf: (def: WorkflowDef) => register(def),
    lookup: (ref: OrderInstructionRef): ResolvedInstructions | undefined => {
      const step = findStep(ref);
      if (step === undefined) return undefined;
      const resolved: ResolvedInstructions = {};
      if (step.body !== '') resolved.prompt = step.body;
      if (step.command !== undefined) resolved.command = step.command;
      return resolved;
    },
    stepDef: findStep,
  };
}

/** The runtime fields an order contributes to placeholder materialization. */
export interface OrderRuntimeVars {
  workflow: string;
  run: string;
  key: string;
  index?: number;
}

/**
 * The runtime placeholder substitution for an order's authored prompt body.
 * Same semantics as the engine's pre-reference-mode rendering: every
 * `${WORKFLOW}`/`${RUN}`/`${STEP}`/`${KEY}`/`${INDEX}`/`${MAX_ATTEMPTS}`
 * occurrence is replaced; an unknown placeholder name is left unchanged,
 * byte for byte. Lives here (not on the low-level source) because the
 * values are runtime fields of the reference order, not authored bytes —
 * the source returns the body as authored, and materialization happens at
 * resolution time, never back onto the order. `maxAttempts` is the AUTHORED
 * step default (from the resolved step, not the order) — matching the old
 * `buildOrder` semantics exactly, including the step-generic note below.
 */
export function substituteOrderVars(
  body: string,
  runtime: OrderRuntimeVars,
  opts: { step?: string; maxAttempts?: number } = {},
): string {
  return body.replace(/\$\{(\w+)\}/g, (m, k: string) => {
    switch (k) {
      case 'WORKFLOW': return runtime.workflow;
      case 'RUN': return runtime.run;
      case 'STEP': return opts.step ?? m;
      case 'KEY': return runtime.key;
      case 'INDEX': return runtime.index === undefined ? '' : String(runtime.index);
      // Intentionally step-generic: a single firing can discharge multiple
      // outputs (order.outputs) at once, so there is no single produce to
      // resolve a per-produce maxAttempts override against here. This
      // always reflects the step default even when individual produces
      // override it (see model.ts effectiveMaxAttempts()).
      case 'MAX_ATTEMPTS': return String(opts.maxAttempts ?? '');
      default: return m;
    }
  });
}

/**
 * An order-facing resolver over an {@link OrderInstructionSource} — the one
 * resolution path both the CLI and embedded callers use. The low-level
 * boundary (`resolve`) calls the source's three-key lookup and raises the
 * named refusal; the convenience layer (`resolveOrder`) materializes the
 * runtime placeholders on top of the exact authored bytes. Neither method
 * ever mutates the stored/emitted order.
 */
export class OrderResolver {
  private readonly source: OrderInstructionSource;

  constructor(source: OrderInstructionSource) {
    this.source = source;
  }

  /** The low-level `(defDigest, step, key)` boundary: exact authored bytes or the named refusal. */
  resolve(ref: OrderInstructionRef): ResolvedInstructions {
    const resolved = this.source.lookup(ref);
    if (resolved === undefined) throw new UnknownDefDigestError(ref.defDigest);
    return resolved;
  }

  /**
   * Resolve a reference-mode order's static instructions and materialize the
   * runtime placeholders (`${WORKFLOW}`/`${RUN}`/`${STEP}`/`${KEY}`/
   * `${INDEX}`/`${MAX_ATTEMPTS}`) in the prompt using the order's own
   * runtime fields. Returns a fresh object — the order itself is never
   * modified, and the materialized prompt is never written back onto it.
   */
  resolveOrder(order: Order): ResolvedInstructions {
    const ref: OrderInstructionRef = { defDigest: order.defDigest, step: order.step, key: order.key };
    const resolved = this.source.lookup(ref);
    if (resolved === undefined) throw new UnknownDefDigestError(order.defDigest);
    if (resolved.prompt === undefined) return resolved;
    const stepDef = this.stepDef(ref);
    return {
      ...resolved,
      prompt: substituteOrderVars(
        resolved.prompt,
        { workflow: order.workflow, run: order.run, key: order.key, ...(order.index !== undefined ? { index: order.index } : {}) },
        { step: order.step, ...(stepDef !== undefined ? { maxAttempts: stepDef.maxAttempts } : {}) },
      ),
    };
  }

  /** The authored step behind a resolvable ref (for placeholder defaults); undefined if the source won't say. */
  private stepDef(ref: OrderInstructionRef): StepDef | undefined {
    return this.source.stepDef?.(ref);
  }
}
