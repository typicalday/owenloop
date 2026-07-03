/**
 * JSON Schema validation for artifact values (design §18).
 *
 * The engine is domain-neutral, but a wiring may still want to guarantee the
 * *shape* of an artifact's captured handle — that a `plan` really is
 * `{ plan: string }`, that an emitted source carries a `url`. A schema attached
 * to a produce/input declaration (defs.ts) is a structural contract the engine
 * enforces at commit time: a `green` / `emit` / `provide` whose value violates
 * the schema is refused. Shape is the engine's business; *meaning* stays a
 * consumer's judgment (a `reject`).
 *
 * Validation is delegated to `@cfworker/json-schema` — full JSON Schema draft
 * 2020-12 and, unlike ajv, zero transitive dependencies and no code generation,
 * which keeps owenloop's dependency tree tiny. We keep our own surface minimal:
 * validate a value, summarize the failures for a reason thread, and assert a
 * schema is itself well-formed (so a bad schema fails at load, not at commit).
 */

import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';
import type { JsonSchema } from './types.ts';

const DRAFT = '2020-12';

/** One schema violation: where in the value it failed, and why. */
export interface SchemaIssue {
  /** JSON Pointer into the value (e.g. "/plan"); "#" for the root. */
  path: string;
  keyword: string;
  message: string;
}

export interface SchemaCheck {
  valid: boolean;
  issues: SchemaIssue[];
}

/**
 * Validate `value` against `schema`. Total: it returns the issues rather than
 * throwing, so the engine can fold them into a reason thread. cfworker resolves
 * `$ref`s lazily *at validate time*, so a malformed schema that slipped past
 * `assertValidSchema` would otherwise throw here mid-commit — we trap that and
 * surface it as an ordinary (engine-authored) validation failure instead.
 */
export function validateValue(schema: JsonSchema, value: unknown): SchemaCheck {
  let result;
  try {
    result = new Validator(schema as Schema, DRAFT).validate(value);
  } catch (e) {
    return { valid: false, issues: [{ path: '#', keyword: 'schema', message: `invalid schema: ${(e as Error).message}` }] };
  }
  if (result.valid) return { valid: true, issues: [] };
  const issues: SchemaIssue[] = result.errors.map((e) => ({
    path: e.instanceLocation || '#',
    keyword: e.keyword,
    message: e.error,
  }));
  return { valid: false, issues };
}

/** A compact one-line rendering of the issues, for an order's reason thread. */
export function summarizeIssues(issues: SchemaIssue[]): string {
  if (issues.length === 0) return 'does not match schema';
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}

/**
 * Assert `schema` is at least structurally a JSON Schema (an object or a boolean)
 * the validator can load. Throws on a malformed schema so a definition fails fast
 * at load (defs.ts) rather than at first commit. This is a gross-error guard
 * (`schema: 42`, an unconstructable `$ref`), not a full meta-schema check.
 */
export function assertValidSchema(schema: unknown, ctx: string): void {
  const objish = typeof schema === 'object' && schema !== null && !Array.isArray(schema);
  if (typeof schema !== 'boolean' && !objish) {
    throw new Error(`${ctx} must be a JSON Schema object or boolean`);
  }
  try {
    // cfworker dereferences `$ref`s lazily at validate time, so construction
    // alone won't surface an unresolved ref — run one trivial validation to
    // force resolution and catch gross errors at load rather than at commit.
    new Validator(schema as Schema, DRAFT).validate({});
  } catch (e) {
    throw new Error(`${ctx} is not a valid JSON Schema: ${(e as Error).message}`);
  }
}
