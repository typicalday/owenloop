import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDef, SUPPORTED_ENGINE_VERSION } from '../src/defs.ts';
import {
  checkInterfaceCompatibility,
  implementsIssues,
  type WorkflowInterfaceSignature,
} from '../src/implements.ts';
import type { JsonSchema } from '../src/types.ts';

const requestSchema: JsonSchema = {
  type: 'object',
  required: ['question'],
  properties: {
    question: { type: 'string', minLength: 1 },
    target: { type: 'string', minLength: 1 },
    constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
};

const researchScope: JsonSchema = {
  type: 'object',
  required: ['question', 'constraints', 'areas', 'excludedAreas'],
  properties: {
    question: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    areas: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object' } },
    excludedAreas: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

const investigateScope: JsonSchema = {
  type: 'object',
  required: ['question', 'includedAreas', 'excludedAreas'],
  properties: {
    question: { type: 'string' },
    includedAreas: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object' } },
    excludedAreas: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

const researchReport: JsonSchema = {
  type: 'object',
  required: ['question', 'answer', 'scope', 'areaResults', 'conclusions', 'gaps'],
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
    scope: researchScope,
    areaResults: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object' } },
    conclusions: { type: 'string' },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

const investigateReport: JsonSchema = {
  type: 'object',
  required: ['question', 'answer', 'scope', 'findings', 'gaps'],
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
    scope: investigateScope,
    findings: { type: 'array', items: { type: 'object' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

const reportInterface: WorkflowInterfaceSignature = {
  inputs: [{ name: 'request', schema: requestSchema }],
  outputs: [{
    name: 'report',
    schema: {
      type: 'object',
      required: ['question', 'answer', 'scope', 'gaps'],
      properties: {
	question: { type: 'string' },
	answer: { type: 'string' },
	scope: { type: 'object' },
	gaps: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  }],
};

function reportDef(name: string, inputSchema: JsonSchema = requestSchema, reportSchema: JsonSchema = researchReport) {
  return buildDef({
    name,
    outputs: ['report'],
    inputs: [{ name: 'request', schema: inputSchema }],
    steps: [{
      name: 'reporter',
      consumes: ['request'],
      produces: [{ name: 'report', schema: reportSchema }],
      terminal: true,
    }],
  });
}

function messages(signature: WorkflowInterfaceSignature, def = reportDef('compat-fixture')): string[] {
  return checkInterfaceCompatibility(signature, def).issues.map((issue) => issue.message);
}

test('x.implements preserves a valid claim on engine version 1', () => {
  const def = buildDef({
    name: 'claim-fixture',
    x: { implements: [{ name: 'research-report', version: '1' }] },
    steps: [{ name: 'work', produces: ['result'], terminal: true }],
  });
  assert.deepEqual(def.x?.implements, [{ name: 'research-report', version: '1' }]);
  assert.equal(SUPPORTED_ENGINE_VERSION, 1);
  assert.deepEqual(implementsIssues(def), []);
});

test('implementsIssues is advisory, field-qualified, and deterministic', () => {
  const fixture = (implementsValue: unknown) => buildDef({
    name: 'claim-lint-fixture',
    x: { implements: implementsValue },
    steps: [{ name: 'work', produces: ['result'], terminal: true }],
  });

  assert.deepEqual(implementsIssues(buildDef({
    name: 'no-claim-fixture',
    steps: [{ name: 'work', produces: ['result'], terminal: true }],
  })), []);
  assert.deepEqual(implementsIssues(fixture([{ name: 'report', version: '1' }])), []);
  assert.deepEqual(implementsIssues(fixture({ name: 'report', version: '1' })), [
    'x.implements: expected a non-empty array',
  ]);
  assert.deepEqual(implementsIssues(fixture([])), ['x.implements: expected a non-empty array']);
  assert.deepEqual(implementsIssues(fixture(['report'])), ['x.implements[0]: expected a map']);
  assert.deepEqual(implementsIssues(fixture([{ version: '1' }])), [
    'x.implements[0].name: expected a non-empty string',
  ]);
  assert.deepEqual(implementsIssues(fixture([{ name: ' ', version: ' ' }])), [
    'x.implements[0].name: expected a non-empty string',
    'x.implements[0].version: expected a non-empty string',
  ]);
  assert.deepEqual(implementsIssues(fixture([{ name: 'report', version: '1', summary: 'wrong' }])), [
    'x.implements[0].summary: unknown field',
  ]);
  assert.deepEqual(implementsIssues(fixture([
    { name: 'report', version: '1' },
    { name: 'report', version: '1' },
  ])), ['x.implements[1]: duplicate interface claim report@1']);
  assert.deepEqual(implementsIssues(fixture([
    { name: 'a', version: 'b\0c' },
    { name: 'a\0b', version: 'c' },
  ])), []);
  assert.deepEqual(implementsIssues(fixture([
    { name: 'a', version: 'b\0c' },
    { name: 'a\0b', version: 'c' },
    { name: 'a', version: 'b\0c' },
  ])), ['x.implements[2]: duplicate interface claim a@b\0c']);
});

test('compatibility accepts the shared request and projected closed report schemas', () => {
  const research = reportDef('research-compatible', requestSchema, researchReport);
  const investigate = reportDef('investigate-compatible', requestSchema, investigateReport);
  const beforeSignature = structuredClone(reportInterface);
  const beforeResearch = structuredClone(research);
  const beforeInvestigate = structuredClone(investigate);

  assert.equal(checkInterfaceCompatibility(reportInterface, research).compatible, true);
  assert.equal(checkInterfaceCompatibility(reportInterface, investigate).compatible, true);
  assert.deepEqual(reportInterface, beforeSignature, 'signature is never mutated');
  assert.deepEqual(research, beforeResearch, 'research def is never mutated');
  assert.deepEqual(investigate, beforeInvestigate, 'investigate def is never mutated');
});

test('closed output projection checks property cardinality after dropping implementation-only fields', () => {
  const signature: WorkflowInterfaceSignature = {
    inputs: [{ name: 'request', schema: requestSchema }],
    outputs: [{
      name: 'report',
      schema: {
	type: 'object',
	minProperties: 1,
	properties: { visible: { type: 'string' } },
	additionalProperties: false,
      },
    }],
  };
  const implementationSchema: JsonSchema = {
    type: 'object',
    minProperties: 1,
    required: ['internal'],
    properties: {
      visible: { type: 'string' },
      internal: { type: 'string' },
    },
    additionalProperties: false,
  };

  const result = checkInterfaceCompatibility(
    signature,
    reportDef('projection-cardinality', requestSchema, implementationSchema),
  );

  assert.equal(result.compatible, false);
  assert.ok(result.issues.some(
    (issue) => issue.message === 'outputs.report.schema.minProperties: projected source minimum 0 does not satisfy target minimum 1',
  ));
});

test('compatibility distinguishes extra required input properties from missing output properties', () => {
  const inputWithExtraRequirement: JsonSchema = {
    type: 'object',
    required: ['question', 'audience'],
    properties: {
      question: { type: 'string', minLength: 1 },
      audience: { type: 'string' },
    },
    additionalProperties: false,
  };
  const outputMissingAnswer: JsonSchema = {
    type: 'object',
    required: ['question', 'scope', 'gaps'],
    properties: {
      question: { type: 'string' },
      scope: { type: 'object' },
      gaps: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  };

  assert.ok(
    messages(reportInterface, reportDef('extra-input-requirement', inputWithExtraRequirement)).some(
      (issue) => issue.includes("implementation-only required property 'audience'"),
    ),
  );
  assert.ok(
    messages(reportInterface, reportDef('missing-output-property', requestSchema, outputMissingAnswer)).some(
      (issue) => issue.includes("implementation output is missing interface property 'answer'"),
    ),
  );
});

test('compatibility intersects const and enum constraints before comparing values', () => {
  const signature: WorkflowInterfaceSignature = {
    inputs: [{ name: 'request', schema: { type: 'string', const: 'ok' } }],
    outputs: [],
  };
  const implementation = reportDef('conflicting-const-enum', {
    type: 'string',
    const: 'ok',
    enum: ['different'],
  });
  const result = checkInterfaceCompatibility(signature, implementation);

  assert.equal(result.compatible, false);
  assert.ok(result.issues.some((issue) => issue.message.includes('source allowed values are not a subset')));
});

test('compatibility validates supported keyword values before directional comparison', () => {
  const inputSignature = (schema: JsonSchema): WorkflowInterfaceSignature => ({
    inputs: [{ name: 'request', schema }],
    outputs: [],
  });
  const outputSignature = (schema: JsonSchema): WorkflowInterfaceSignature => ({
    inputs: [{ name: 'request', schema: requestSchema }],
    outputs: [{ name: 'report', schema }],
  });

  assert.ok(
    messages(outputSignature({ type: 'string' }), reportDef('bad-min-length', requestSchema, {
      type: 'string',
      minLength: 'bad',
    })).some((issue) => issue.includes('minLength: expected a non-negative integer')),
  );
  assert.ok(
    messages(outputSignature({ type: 'string', pattern: 42 }), reportDef('bad-pattern', requestSchema, {
      type: 'string',
    })).some((issue) => issue.includes('pattern: expected a string')),
  );
  const invalidInputPattern = checkInterfaceCompatibility(
    inputSignature({ type: 'string', pattern: '[' }),
    reportDef('invalid-input-pattern', { type: 'string' }),
  );
  assert.equal(invalidInputPattern.compatible, false);
  assert.ok(invalidInputPattern.issues.some(
    (issue) => issue.message.includes('inputs[0].schema.pattern: expected a valid ECMA-262 Unicode regular expression'),
  ));
  const invalidOutputPattern = checkInterfaceCompatibility(
    outputSignature({ type: 'string' }),
    reportDef('invalid-output-pattern', requestSchema, { type: 'string', pattern: '[' }),
  );
  assert.equal(invalidOutputPattern.compatible, false);
  assert.ok(invalidOutputPattern.issues.some(
    (issue) => issue.message.includes('outputs.report.schema.pattern: expected a valid ECMA-262 Unicode regular expression'),
  ));
  assert.ok(
    messages(outputSignature({ type: 'string' }), reportDef('bad-format', requestSchema, {
      type: 'string',
      format: false,
    })).some((issue) => issue.includes('format: expected a string')),
  );
  assert.ok(
    messages(outputSignature({ type: 'array' }), reportDef('bad-items', requestSchema, {
      type: 'array',
      items: [],
    })).some((issue) => issue.includes('items: expected a JSON Schema object or boolean')),
  );
  assert.ok(
    messages(outputSignature({ type: 'array' }), reportDef('bad-cardinality', requestSchema, {
      type: 'array',
      minItems: -1,
    })).some((issue) => issue.includes('minItems: expected a non-negative integer')),
  );
  assert.ok(
    messages(outputSignature({ type: 'number' }), reportDef('bad-bound', requestSchema, {
      type: 'number',
      minimum: 'bad',
    })).some((issue) => issue.includes('minimum: expected a finite number')),
  );
  assert.ok(
    messages(inputSignature({ type: 'mystery' }), reportDef('unknown-type', { type: 'string' })).some(
      (issue) => issue.includes('type: expected a string or an array of strings'),
    ),
  );
});

test('compatibility fails closed for missing schemas, primitives, booleans, open surfaces, and unsupported keywords', () => {
  const missingInterfaceSchema: WorkflowInterfaceSignature = {
    inputs: [{ name: 'request' }],
    outputs: reportInterface.outputs,
  };
  assert.ok(messages(missingInterfaceSchema).some((issue) => issue.includes('inputs[0].schema: expected a JSON Schema')));

  const primitiveMismatch: WorkflowInterfaceSignature = {
    inputs: [{ name: 'request', schema: { type: 'string' } }],
    outputs: [],
  };
  assert.ok(messages(primitiveMismatch, reportDef('primitive-mismatch', { type: 'number' })).some(
    (issue) => issue.includes('source types are not a subset of target types'),
  ));

  const booleanInput: WorkflowInterfaceSignature = { inputs: [{ name: 'request', schema: true }], outputs: [] };
  assert.ok(messages(booleanInput, reportDef('boolean-input', false)).some(
    (issue) => issue.includes('source schema accepts values'),
  ));
  const booleanOutput: WorkflowInterfaceSignature = {
    inputs: [{ name: 'request', schema: requestSchema }],
    outputs: [{ name: 'report', schema: false }],
  };
  assert.ok(messages(booleanOutput, reportDef('boolean-output', requestSchema, true)).some(
    (issue) => issue.includes('source schema accepts values'),
  ));

  const openInput: WorkflowInterfaceSignature = {
    inputs: [{ name: 'request', schema: { type: 'object', additionalProperties: true } }],
    outputs: [],
  };
  assert.ok(messages(openInput, reportDef('open-input', { type: 'object', additionalProperties: false })).some(
    (issue) => issue.includes('additionalProperties'),
  ));

  const openOutput: WorkflowInterfaceSignature = {
    inputs: [{ name: 'request', schema: requestSchema }],
    outputs: [{ name: 'report', schema: { type: 'object', additionalProperties: false } }],
  };
  assert.ok(messages(openOutput, reportDef('open-output', requestSchema, { type: 'object' })).some(
    (issue) => issue.includes('unprovable open-property surface'),
  ));

  const unsupported: WorkflowInterfaceSignature = {
    inputs: [{ name: 'request', schema: { oneOf: [{ type: 'string' }, { type: 'number' }] } }],
    outputs: [],
  };
  assert.ok(messages(unsupported).some((issue) => issue.includes('oneOf: unsupported JSON Schema keyword')));
});

test('compatibility reports missing implementation artifact schemas and workflow-level extra inputs', () => {
  const missingOutputSchema = buildDef({
    name: 'missing-output-schema',
    outputs: ['report'],
    inputs: [{ name: 'request', schema: requestSchema }],
    steps: [{ name: 'reporter', consumes: ['request'], produces: ['report'], terminal: true }],
  });
  assert.ok(messages(reportInterface, missingOutputSchema).some(
    (issue) => issue.includes("workflow does not declare public output 'report' with a schema"),
  ));

  const extraInput = buildDef({
    name: 'extra-workflow-input',
    outputs: ['report'],
    inputs: [{ name: 'request', schema: requestSchema }, { name: 'operator', schema: { type: 'string' } }],
    steps: [{
      name: 'reporter',
      consumes: ['request', 'operator'],
      produces: [{ name: 'report', schema: researchReport }],
      terminal: true,
    }],
  });
  assert.ok(messages(reportInterface, extraInput).some(
    (issue) => issue.includes("workflow declares additional input 'operator' not in the interface"),
  ));
});
