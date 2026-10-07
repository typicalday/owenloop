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

test('nested arrays exhaust the concrete candidate budget without exhausting memory', { timeout: 5_000 }, () => {
  let nested: Record<string, unknown> = { type: 'string' };
  for (let depth = 0; depth < 16; depth++) {
    nested = { type: 'array', minItems: 4, items: nested };
  }
  const schema = { type: 'object', required: ['payload'], properties: { payload: nested } };
  const witnesses = collectionValueWitnesses(schema);
  assert.equal(witnesses.validClassKnown, false, 'no partial candidate is promoted to a valid witness');
});
