import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidSchema, summarizeIssues, validateValue } from '../src/schema.ts';

const planSchema = {
  type: 'object',
  required: ['plan'],
  properties: {
    plan: { type: 'string', minLength: 1 },
    points: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

test('validateValue accepts a conforming value', () => {
  const r = validateValue(planSchema, { plan: 'ship it', points: 3 });
  assert.equal(r.valid, true);
  assert.deepEqual(r.issues, []);
});

test('validateValue reports a missing required property', () => {
  const r = validateValue(planSchema, { points: 3 });
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.keyword === 'required'));
  assert.ok(r.issues.every((i) => i.path.startsWith('#')));
});

test('validateValue reports a nested constraint with a JSON-pointer path', () => {
  const r = validateValue(planSchema, { plan: 'ok', points: -1 });
  assert.equal(r.valid, false);
  const minimum = r.issues.find((i) => i.keyword === 'minimum');
  assert.ok(minimum, 'has a minimum violation');
  assert.equal(minimum!.path, '#/points');
});

test('validateValue reports an unexpected (additional) property', () => {
  const r = validateValue(planSchema, { plan: 'ok', surprise: 1 });
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.keyword === 'additionalProperties'));
});

test('validateValue handles a root-level type mismatch with path "#"', () => {
  const r = validateValue(planSchema, 42);
  assert.equal(r.valid, false);
  assert.equal(r.issues[0]!.path, '#');
  assert.equal(r.issues[0]!.keyword, 'type');
});

test('a boolean schema of true accepts anything, false rejects everything', () => {
  assert.equal(validateValue(true, { anything: 1 }).valid, true);
  assert.equal(validateValue(false, {}).valid, false);
});

test('full draft 2020-12: $ref, allOf, and format compose', () => {
  const schema = {
    $defs: { nonEmpty: { type: 'string', minLength: 1 } },
    type: 'object',
    properties: {
      id: { $ref: '#/$defs/nonEmpty' },
      when: { type: 'string', format: 'date-time' },
    },
    allOf: [{ required: ['id'] }],
  };
  assert.equal(validateValue(schema, { id: 'x', when: '2026-06-16T00:00:00Z' }).valid, true);
  assert.equal(validateValue(schema, { id: '' }).valid, false); // fails the $ref'd minLength
  assert.equal(validateValue(schema, { when: 'x' }).valid, false); // fails allOf.required
});

test('summarizeIssues renders a compact one-line digest', () => {
  const r = validateValue(planSchema, { points: -1 });
  const text = summarizeIssues(r.issues);
  assert.match(text, /#/);
  assert.ok(text.includes(';') || r.issues.length === 1);
});

test('summarizeIssues has a sensible fallback for an empty list', () => {
  assert.equal(summarizeIssues([]), 'does not match schema');
});

test('assertValidSchema accepts an object schema and a boolean schema', () => {
  assert.doesNotThrow(() => assertValidSchema(planSchema, 'ctx'));
  assert.doesNotThrow(() => assertValidSchema(true, 'ctx'));
  assert.doesNotThrow(() => assertValidSchema(false, 'ctx'));
});

test('assertValidSchema rejects a non-object, non-boolean schema', () => {
  assert.throws(() => assertValidSchema(42, 'output schema'), /must be a JSON Schema object or boolean/);
  assert.throws(() => assertValidSchema([1, 2], 'output schema'), /must be a JSON Schema object or boolean/);
  assert.throws(() => assertValidSchema(null, 'output schema'), /must be a JSON Schema object or boolean/);
});

test('assertValidSchema rejects a schema the validator cannot construct', () => {
  // an unresolved $ref is a gross error surfaced at construction time
  assert.throws(() => assertValidSchema({ $ref: '#/nope' }, 'output schema'), /is not a valid JSON Schema/);
});
