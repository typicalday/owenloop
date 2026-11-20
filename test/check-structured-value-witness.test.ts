/** Concrete checker value witnesses must open real schema-accepted paths. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionValueWitnesses, modelCheck } from '../src/model.ts';
import { validateValue } from '../src/schema.ts';
import { def, input, step } from './helpers.ts';

const structuredSchema = {
  type: 'object', required: ['outcome', 'flows', 'matrix'],
  properties: {
    outcome: { enum: ['mapped'] },
    flows: { type: 'array', items: {
      type: 'object', required: ['id', 'kind'],
      properties: {
        id: { type: 'string', pattern: '^E[1-9][0-9]*$' },
        kind: { oneOf: [{ const: 'record' }, { const: 'other' }] },
      },
    } },
    matrix: { type: 'object', required: ['rows'], properties: {
      rows: { type: 'array', items: { type: 'string', minLength: 1 } },
    } },
  },
  allOf: [{
    if: { properties: { outcome: { const: 'mapped' } }, required: ['outcome'] },
    then: { properties: { flows: { minItems: 1 }, matrix: { properties: { rows: { minItems: 1 } } } } },
  }],
  additionalProperties: false,
} as const;

test('checker reaches downstream steps through a concrete nested schema witness', () => {
  const produce = step({ name: 'shape', consumes: ['start'], produces: ['evidence'],
    maxAttempts: 1, maxSchemaFailures: 0 });
  produce.produces[0]!.schema = structuredSchema;
  const workflow = def('structured-checker-witness', [input('start', { seedOwed: false })], [
    produce,
    step({ name: 'consume', consumes: ['evidence'], produces: ['done'],
      maxAttempts: 1, maxSchemaFailures: 0 }),
  ]);
  const concrete = { outcome: 'mapped', flows: [{ id: 'E1', kind: 'record' }],
    matrix: { rows: ['x'] } };
  assert.equal(validateValue(structuredSchema, concrete).valid, true);
  const report = modelCheck(workflow, { maxStates: 500, assumeProvided: true });
  assert.ok(!report.coverageIncomplete.includes('singleton-schema-validity'));
  assert.ok(!report.unreachedSteps.includes('consume'));
  assert.equal(report.structurallyDeadSteps.length, 0);
});

test('checker samples required arrays beyond four items when the concrete value fits its budget', () => {
  const schema = { type: 'object', required: ['principles', 'skills', 'tag'], properties: {
    principles: { type: 'array', minItems: 21, maxItems: 21 },
    skills: { type: 'array', minItems: 23, maxItems: 23, uniqueItems: true, items: { type: 'integer' } },
    tag: { type: 'string', pattern: '^z{8}$' },
  } };
  const witness = collectionValueWitnesses(schema);
  assert.deepEqual(witness.valid, {
    principles: Array.from({ length: 21 }, (_, index) => index),
    skills: Array.from({ length: 23 }, (_, index) => index),
    tag: 'zzzzzzzz',
  });
  assert.equal(validateValue(schema, witness.valid).valid, true);
  const produce = step({ name: 'context', produces: ['receipt'] });
  produce.produces[0]!.schema = schema;
  const workflow = def('array-minimum', [], [produce, step({ name: 'classify', consumes: ['receipt'], produces: ['done'] })]);
  const report = modelCheck(workflow, { maxStates: 500, assumeProvided: true });
  assert.ok(!report.coverageIncomplete.includes('singleton-schema-validity'));
  assert.ok(!report.unreachedSteps.includes('classify'));
});

test('larger array samples respect the width limit and original item validator', () => {
  for (const items of [
    { type: 'array', minItems: 33 },
    { type: 'array', minItems: 21, items: { const: { label: 'large'.repeat(2_000) } } },
  ]) {
    const witness = collectionValueWitnesses({ type: 'object', required: ['items'], properties: { items } });
    assert.equal(witness.validClassKnown, false);
    assert.equal(witness.valid, undefined);
  }
});

test('checker leaves a genuinely unsampled valid class incomplete', () => {
  const produce = step({ name: 'shape', consumes: ['start'], produces: ['evidence'],
    maxAttempts: 1, maxSchemaFailures: 0 });
  produce.produces[0]!.schema = { type: 'object', required: ['items'], properties: {
    items: { type: 'array', minItems: 5, items: { type: 'string' } },
  } };
  const workflow = def('bounded-checker-witness', [input('start', { seedOwed: false })], [
    produce, step({ name: 'consume', consumes: ['evidence'], produces: ['done'] }),
  ]);
  const report = modelCheck(workflow, { maxStates: 500, assumeProvided: true });
  assert.ok(report.coverageIncomplete.includes('singleton-schema-validity'));
  assert.ok(report.unreachedSteps.includes('consume'));
});

test('anchored string samples can open a nested receipt with hashes, names and an escaped URL', () => {
  const slug = '[A-Za-z0-9_.-]+';
  const schema = { type: 'object', required: ['receipt'], properties: {
    receipt: { type: 'object', required: ['hash', 'pair', 'url'], properties: {
      hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      pair: { type: 'string', pattern: `^${slug}/${slug}$`, minLength: 12 },
      url: { type: 'string', pattern: `^https://example\\.com/${slug}/${slug}\\.git$` },
    } },
  } };
  const witness = collectionValueWitnesses(schema).valid;
  assert.ok(witness);
  assert.equal(validateValue(schema, witness).valid, true);
  const produce = step({ name: 'snapshot', produces: ['receipt'] });
  produce.produces[0]!.schema = schema;
  const workflow = def('patterned-receipt', [], [produce, step({ name: 'review', consumes: ['receipt'], produces: ['done'] })]);
  const report = modelCheck(workflow);
  assert.deepEqual(report.unreachedSteps, []);
  assert.deepEqual(report.coverageIncomplete, []);
});

test('unrecognized or oversized patterns and a conflicting length remain unsampled', () => {
  for (const constraint of [
    { pattern: '^(red|blue)$' }, { pattern: '^[a-f]{129}$' },
    { pattern: '^' + 'q'.repeat(257) + '$' }, { pattern: '^[a-z]+$', minLength: 129 },
    { pattern: '^[0-9a-f]{64}$', maxLength: 32 },
  ]) {
    const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string', ...constraint } } };
    const witnesses = collectionValueWitnesses(schema);
    assert.equal(witnesses.valid, undefined);
    assert.equal(witnesses.validClassKnown, false);
  }
});

test('a different valid pattern sample does not replace an accepted legacy string', () => {
  const schema = { type: 'object', required: ['id'], properties: {
    id: { type: 'string', anyOf: [{ type: 'string', pattern: '^z{4}$' }, { const: 'x' }] },
  } };
  assert.equal(validateValue(schema, { id: 'zzzz' }).valid, true);
  assert.deepEqual(collectionValueWitnesses(schema).valid, { id: 'x' });
});

test('patterned siblings admit named modifiers after previously witnessed routes', () => {
  const produce = step({ name: 'choose', produces: ['choice'] });
  const output = produce.produces[0]!;
  output.bind = { to: 'modifier', from: 'route' };
  output.schema = { type: 'object', required: ['route', 'hash'], properties: {
    route: { type: 'string' }, hash: { type: 'string' },
  }, anyOf: [
    { properties: { hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    { properties: { hash: { const: 'x' }, route: { const: 'deep' } } },
  ] };
  const workflow = def('patterned-modifier', [], [produce], ['quick', 'deep']);
  const report = modelCheck(workflow);
  assert.equal(report.completePath?.[0]?.selectedModifier, 'deep');
  assert.ok(!report.coverageIncomplete.includes('singleton-bind-modifier'));
});

test('unbound singletons find both outcomes when only a late array sample distinguishes them', () => {
  for (const schema of [{ allOf: [{ type: 'array' }] }, { not: { type: 'array' } }]) {
    const produce = step({ name: 'produce', produces: ['result'], maxSchemaFailures: 1 });
    produce.produces[0]!.schema = schema;
    const report = modelCheck(def('unbound-witnesses', [], [produce]));
    assert.deepEqual(report.completePath?.map((move) => move.outcome), ['green']);
    assert.deepEqual(report.stallStates.map(({ path }) => path.map((move) => move.outcome)),
      [['schema-reject']]);
    assert.deepEqual(report.coverageIncomplete, []);
  }
});

test('nested arrays exhaust the concrete candidate budget without exhausting memory', { timeout: 5_000 }, () => {
  let nested: Record<string, unknown> = { type: 'string' };
  for (let depth = 0; depth < 16; depth++) {
    nested = { type: 'array', minItems: 4, items: nested };
  }
  const schema = { type: 'object', required: ['payload'], properties: { payload: nested } };
  const witnesses = collectionValueWitnesses(schema);
  assert.equal(witnesses.validClassKnown, false, 'no partial candidate is promoted to a valid witness');
});

for (const keyword of ['anyOf', 'oneOf']) {
  test(`checker samples ${keyword} with required fields and nested property constraints from both sides`, () => {
    const schema = {
      type: 'object', required: ['id', 'data'],
      properties: {
	id: { const: 'run-1' },
	data: { type: 'object', required: ['records'], properties: {
	  records: { type: 'array', items: { type: 'string' } },
	} },
      },
      [keyword]: [{ required: ['stage'], properties: {
	stage: { const: 'recorded' },
	data: { required: ['label'], properties: {
	  records: { minItems: 1 }, label: { const: 'sample' },
	} },
      } }, false],
    };
    const { valid } = collectionValueWitnesses(schema);
    assert.deepEqual(valid, { id: 'run-1', data: { records: ['x'], label: 'sample' }, stage: 'recorded' });
    assert.equal(validateValue(schema, valid).valid, true);
  });
}

test('checker samples a union inside an array item with constraints from both item schemas', () => {
  const schema = { required: ['entries'], properties: {
    entries: { type: 'array', minItems: 1, items: {
      type: 'object', required: ['id'], properties: { id: { type: 'string' } },
      anyOf: [{ properties: { id: { minLength: 3 } } }],
    } },
  }, oneOf: [{ properties: { entries: { items: { required: ['ready'], properties: { ready: { const: true } } } } } }] };
  const { valid } = collectionValueWitnesses(schema);
  assert.deepEqual(valid, { entries: [{ id: 'xxx', ready: true }] });
  assert.equal(validateValue(schema, valid).valid, true);
});

test('checker preserves branch-only witnesses and samples a true alternative with siblings', () => {
  const branch = { required: ['payload'] };
  assert.deepEqual(collectionValueWitnesses({ oneOf: [branch, false] }).valid, { payload: {} });
  assert.deepEqual(collectionValueWitnesses({ anyOf: [branch], properties: {
    payload: { type: ['array', 'object'] },
  } }).valid, { payload: {} }, 'keep the original first accepted object if both candidates validate');
  assert.deepEqual(collectionValueWitnesses({ anyOf: [branch], properties: {
    payload: { type: ['array', 'object'], minItems: 5 },
  } }).valid, { payload: {} });
  assert.deepEqual(collectionValueWitnesses({ oneOf: [true, false], required: ['stamp'],
    properties: { stamp: { const: 'ready' } } }).valid, { stamp: 'ready' });
});

test('checker leaves impossible and ambiguous unions without an accepted witness', () => {
  const parent = { required: ['tag'], properties: { tag: { const: 'parent' } } };
  for (const union of [
    { anyOf: [false] },
    { anyOf: [{ properties: { tag: { const: 'conflict' } } }] },
    { oneOf: [true, { properties: { tag: { const: 'parent' } } }] },
  ]) {
    const { valid, validClassKnown } = collectionValueWitnesses({ type: 'object', ...parent, ...union });
    assert.equal(valid, undefined);
    assert.equal(validClassKnown, false);
  }
});

test('union hints only visit sampled fields and retain a legacy witness when their shared budget runs out', () => {
  let optional: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 64; i++) optional = { properties: { child: optional } };
  const schema = { required: ['stamp'], properties: { stamp: { const: 'ready' }, optional },
    anyOf: [{ properties: { optional } }] };
  assert.deepEqual(collectionValueWitnesses(schema).valid, { stamp: 'ready' });

  let expensive: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 6; i++) expensive = { type: 'array', minItems: 4, items: expensive };
  const requiredPayload = { anyOf: [{ required: ['payload'] }] };
  const fallback = { ...requiredPayload, properties: { payload: { ...expensive, type: ['array', 'object'] } } };
  assert.deepEqual(collectionValueWitnesses(fallback).valid, { payload: {} });
  const incomplete = collectionValueWitnesses({ ...requiredPayload, properties: { payload: expensive } });
  assert.equal(incomplete.valid, undefined);
  assert.equal(incomplete.validClassKnown, false);
});

test('checker never admits a missing JSON value inside a sampled object or array', () => {
  const noJsonValue = { not: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] } };
  for (const [shape, hint] of [
    [noJsonValue, false],
    [{ type: 'array', minItems: 1, items: noJsonValue }, { items: false }],
  ]) {
    const schema = { type: 'object', required: ['stamp'], properties: { stamp: shape },
      anyOf: [{ properties: { stamp: hint } }, true] };
    const result = collectionValueWitnesses(schema);
    assert.equal(result.valid, undefined);
    assert.equal(result.validClassKnown, false);
  }
});

test('singleton modifier bindings can vary a complete union witness within the candidate limit', () => {
  const produce = step({ name: 'route', produces: ['decision'] });
  const action = produce.produces[0]!;
  action.schema = { type: 'object', required: ['records', 'choice'], properties: {
    records: { type: 'array', items: { type: 'string' } }, choice: { type: 'string' },
  }, anyOf: [{ properties: { records: { minItems: 1 } } }] };
  action.bind = { to: 'modifier', from: 'choice' };
  const workflow = def('sampled-union-route', [], [produce]);
  workflow.modifiers = ['quick', 'deep'];
  const report = modelCheck(workflow, { maxStates: 100 });
  assert.ok(!report.coverageIncomplete.includes('singleton-bind-validity'));
  assert.ok(!report.coverageIncomplete.includes('singleton-bind-modifier'));
});

test('conditional hints keep a concrete field when a previous hint switches off the condition', () => {
  const schema = { type: 'object', required: ['mode', 'note'],
    properties: { mode: { type: 'string' }, note: { const: 'kept' } },
    allOf: [{ if: { properties: { mode: { const: 'x' } } },
      then: { properties: { mode: { const: 'skip' }, note: false } } }],
  };
  const { valid } = collectionValueWitnesses(schema);
  assert.deepEqual(valid, { mode: 'skip', note: 'kept' });
  assert.equal(validateValue(schema, valid).valid, true);
});
