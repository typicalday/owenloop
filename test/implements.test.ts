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

// Fully resolved public-report fixtures copied from owenloop-playbooks@45f95d2
// (workflows/investigate.yaml and workflows/research.yaml). They stay local so
// this suite does not depend on a sibling checkout at runtime.
const pinnedInvestigateScope: JsonSchema = {
  type: 'object',
  required: ['question', 'includedAreas', 'excludedAreas'],
  properties: {
    question: { type: 'string', minLength: 1 },
    includedAreas: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
	type: 'object',
	required: ['id', 'question', 'rationale', 'decisionIndex'],
	properties: {
	  id: { type: 'string', minLength: 1 },
	  question: { type: 'string', minLength: 1 },
	  rationale: { type: 'string', minLength: 1 },
	  decisionIndex: { type: 'integer', minimum: 0 },
	},
	additionalProperties: false,
      },
    },
    excludedAreas: {
      type: 'array',
      items: {
	type: 'object',
	required: ['subject', 'reason', 'decisionIndex'],
	properties: {
	  subject: { type: 'string', minLength: 1 },
	  reason: { type: 'string', minLength: 1 },
	  decisionIndex: { type: 'integer', minimum: 0 },
	},
	additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const pinnedInvestigateEvidencePointer: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'path', 'line'],
      properties: {
	kind: { const: 'file-line' },
	path: { type: 'string', minLength: 1 },
	line: { type: 'integer', minimum: 1 },
	endLine: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['kind', 'path'],
      properties: { kind: { const: 'path' }, path: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['kind', 'receiptRef'],
      properties: { kind: { const: 'command-receipt' }, receiptRef: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
  ],
};

const pinnedInvestigateFinding: JsonSchema = {
  type: 'object',
  required: ['id', 'areaId', 'claim', 'evidence'],
  properties: {
    id: { type: 'string', minLength: 1 },
    areaId: { type: 'string', minLength: 1 },
    claim: { type: 'string', minLength: 1 },
    evidence: { type: 'array', minItems: 1, items: pinnedInvestigateEvidencePointer },
  },
  additionalProperties: false,
};

const pinnedInvestigateGap: JsonSchema = {
  type: 'object',
  required: ['areaId', 'question', 'reason'],
  properties: {
    areaId: { type: 'string', minLength: 1 },
    question: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const pinnedInvestigateReport: JsonSchema = {
  type: 'object',
  required: ['question', 'answer', 'scope', 'findings', 'gaps'],
  properties: {
    question: { type: 'string', minLength: 1 },
    answer: { type: 'string', minLength: 1 },
    scope: pinnedInvestigateScope,
    findings: { type: 'array', items: pinnedInvestigateFinding },
    gaps: { type: 'array', items: pinnedInvestigateGap },
  },
  additionalProperties: false,
};

const pinnedResearchScope: JsonSchema = {
  type: 'object',
  required: ['question', 'constraints', 'areas', 'excludedAreas'],
  properties: {
    question: { type: 'string', minLength: 1 },
    target: { type: 'string', minLength: 1 },
    constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
    areas: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
	type: 'object',
	required: ['ordinal', 'id', 'question', 'rationale'],
	properties: {
	  ordinal: { type: 'integer', enum: [1, 2, 3] },
	  id: { enum: ['area-one', 'area-two', 'area-three'] },
	  question: { type: 'string', minLength: 1 },
	  rationale: { type: 'string', minLength: 1 },
	},
	additionalProperties: false,
      },
    },
    excludedAreas: {
      type: 'array',
      items: {
	type: 'object',
	required: ['subject', 'reason'],
	properties: {
	  subject: { type: 'string', minLength: 1 },
	  reason: { type: 'string', minLength: 1 },
	},
	additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const pinnedResearchEvidence: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'url'],
      properties: {
	kind: { const: 'url' },
	url: { type: 'string', minLength: 1 },
	title: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['kind', 'path', 'line'],
      properties: {
	kind: { const: 'file-line' },
	path: { type: 'string', minLength: 1 },
	line: { type: 'integer', minimum: 1 },
	endLine: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['kind', 'path'],
      properties: { kind: { const: 'path' }, path: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['kind', 'receiptRef'],
      properties: { kind: { const: 'command-receipt' }, receiptRef: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
  ],
};

const pinnedResearchFinding: JsonSchema = {
  type: 'object',
  required: ['id', 'claim', 'evidence'],
  properties: {
    id: { type: 'string', minLength: 1 },
    claim: { type: 'string', minLength: 1 },
    evidence: { type: 'array', minItems: 1, items: pinnedResearchEvidence },
  },
  additionalProperties: false,
};

const pinnedResearchGap: JsonSchema = {
  type: 'object',
  required: ['question', 'reason'],
  properties: {
    question: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const pinnedResearchAreaResult: JsonSchema = {
  type: 'object',
  required: ['ordinal', 'areaId', 'question', 'summary', 'findings', 'gaps'],
  properties: {
    ordinal: { type: 'integer', enum: [1, 2, 3] },
    areaId: { enum: ['area-one', 'area-two', 'area-three'] },
    question: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    findings: { type: 'array', items: pinnedResearchFinding },
    gaps: { type: 'array', items: pinnedResearchGap },
  },
  anyOf: [
    { properties: { findings: { minItems: 1 } } },
    { properties: { gaps: { minItems: 1 } } },
  ],
  additionalProperties: false,
};

const pinnedResearchReport: JsonSchema = {
  type: 'object',
  required: ['question', 'answer', 'scope', 'areaResults', 'conclusions', 'gaps'],
  properties: {
    question: { type: 'string', minLength: 1 },
    answer: { type: 'string', minLength: 1 },
    scope: pinnedResearchScope,
    areaResults: { type: 'array', minItems: 3, maxItems: 3, items: pinnedResearchAreaResult },
    conclusions: {
      type: 'array',
      items: {
	type: 'object',
	required: ['claim', 'findingIds'],
	properties: {
	  claim: { type: 'string', minLength: 1 },
	  findingIds: {
	    type: 'array',
	    minItems: 1,
	    uniqueItems: true,
	    items: { type: 'string', minLength: 1 },
	  },
	},
	additionalProperties: false,
      },
    },
    gaps: {
      type: 'array',
      items: {
	type: 'object',
	required: ['areaId', 'question', 'reason'],
	properties: {
	  areaId: { enum: ['area-one', 'area-two', 'area-three'] },
	  question: { type: 'string', minLength: 1 },
	  reason: { type: 'string', minLength: 1 },
	},
	additionalProperties: false,
      },
    },
  },
  anyOf: [
    { properties: { conclusions: { minItems: 1 } } },
    { properties: { gaps: { minItems: 1 } } },
  ],
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

function outputOnlyDef(name: string, schema: JsonSchema) {
  return buildDef({
    name,
    outputs: ['report'],
    steps: [{
      name: 'reporter',
      produces: [{ name: 'report', schema }],
      terminal: true,
    }],
  });
}

function outputCompatibility(source: JsonSchema, target: JsonSchema) {
  return checkInterfaceCompatibility({
    inputs: [],
    outputs: [{ name: 'report', schema: target }],
  }, outputOnlyDef('output-compatibility', source));
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

});

test('compatibility recursively validates oneOf, anyOf, and uniqueItems values', () => {
  const invalidSchemas: Array<[string, JsonSchema, string]> = [
    ['non-array oneOf', { oneOf: {} }, 'outputs[0].schema.oneOf'],
    ['empty oneOf', { oneOf: [] }, 'outputs[0].schema.oneOf'],
    ['non-array anyOf', { anyOf: {} }, 'outputs[0].schema.anyOf'],
    ['empty anyOf', { anyOf: [] }, 'outputs[0].schema.anyOf'],
    ['non-schema branch', { oneOf: [42] }, 'outputs[0].schema.oneOf[0]'],
    ['invalid nested branch', { anyOf: [{ type: 42 }] }, 'outputs[0].schema.anyOf[0].type'],
    ['non-boolean uniqueItems', { type: 'array', uniqueItems: 'yes' }, 'outputs[0].schema.uniqueItems'],
  ];

  for (const [label, invalidSchema, path] of invalidSchemas) {
    const result = outputCompatibility({ type: 'string' }, invalidSchema);
    assert.ok(result.issues.some((issue) => issue.path === path), label);
  }
});

test('compatibility is reflexive for pinned investigate and research public reports', () => {
  for (const [name, report] of [
    ['investigate', pinnedInvestigateReport],
    ['research', pinnedResearchReport],
  ] as const) {
    const interfaceSchema = structuredClone(report);
    const implementationSchema = structuredClone(report);
    assert.notStrictEqual(interfaceSchema, implementationSchema);
    const result = outputCompatibility(implementationSchema, interfaceSchema);
    assert.equal(result.compatible, true, name);
    assert.deepEqual(result.issues, [], name);
  }
});

test('compatibility rejects a source covered by overlapping target oneOf branches', () => {
  const source: JsonSchema = {
    type: 'object',
    required: ['value'],
    properties: { value: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };
  const target: JsonSchema = {
    oneOf: [
      {
	type: 'object',
	required: ['value'],
	properties: { value: { type: 'string' } },
	additionalProperties: false,
      },
      {
	type: 'object',
	required: ['value'],
	properties: { value: { type: 'string', minLength: 1 } },
	additionalProperties: false,
      },
    ],
  };

  const result = outputCompatibility(source, target);
  assert.equal(result.compatible, false);
  assert.ok(result.issues.some((issue) => issue.path === 'outputs.report.schema.oneOf'));
});

test('compatibility accepts a target oneOf with required const discriminators', () => {
  const target: JsonSchema = {
    oneOf: [
      {
	type: 'object',
	required: ['kind', 'path'],
	properties: {
	  kind: { const: 'path' },
	  path: { type: 'string', minLength: 1 },
	},
	additionalProperties: false,
      },
      {
	type: 'object',
	required: ['kind', 'receiptRef'],
	properties: {
	  kind: { const: 'command-receipt' },
	  receiptRef: { type: 'string', minLength: 1 },
	},
	additionalProperties: false,
      },
    ],
  };
  const source = structuredClone((target as { oneOf: JsonSchema[] }).oneOf[0]!);

  const result = outputCompatibility(source, target);
  assert.equal(result.compatible, true);
  assert.deepEqual(result.issues, []);
});

test('compatibility rejects a target oneOf with optional discriminators', () => {
  const source: JsonSchema = {
    type: 'object',
    properties: { kind: { const: 'path' } },
    additionalProperties: false,
  };
  const target: JsonSchema = {
    oneOf: [
      { type: 'object', properties: { kind: { const: 'path' } }, additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'command-receipt' } }, additionalProperties: false },
    ],
  };

  const result = outputCompatibility(source, target);
  assert.equal(result.compatible, false);
  assert.ok(result.issues.some((issue) => issue.path === 'outputs.report.schema.oneOf'));
});

test('compatibility rejects a union branch without target coverage', () => {
  const source: JsonSchema = { anyOf: [{ type: 'string', const: 'unmatched' }] };
  const target: JsonSchema = { anyOf: [{ type: 'string', const: 'matched' }] };

  const result = outputCompatibility(source, target);
  assert.equal(result.compatible, false);
  assert.ok(result.issues.some((issue) => issue.path === 'outputs.report.schema.anyOf[0]'));
});

test('compatibility applies uniqueItems narrowing directionally', () => {
  const duplicatePermitting: JsonSchema = { type: 'array', items: { type: 'string' } };
  const uniqueOnly: JsonSchema = { type: 'array', uniqueItems: true, items: { type: 'string' } };

  assert.equal(outputCompatibility(uniqueOnly, uniqueOnly).compatible, true);
  const duplicateSource = outputCompatibility(duplicatePermitting, uniqueOnly);
  assert.equal(duplicateSource.compatible, false);
  assert.ok(duplicateSource.issues.some((issue) => issue.path === 'outputs.report.schema.uniqueItems'));
  assert.equal(outputCompatibility(uniqueOnly, duplicatePermitting).compatible, true);
});

test('compatibility keeps every out-of-scope JSON Schema keyword unsupported', () => {
  const unsupportedKeywords: Array<[string, unknown]> = [
    ['allOf', [{ type: 'string' }]],
    ['if', { type: 'string' }],
    ['then', { type: 'string' }],
    ['else', { type: 'string' }],
    ['not', { type: 'string' }],
    ['$ref', '#/definitions/value'],
    ['prefixItems', [{ type: 'string' }]],
    ['patternProperties', { value: { type: 'string' } }],
    ['contains', { type: 'string' }],
    ['dependentRequired', { value: ['other'] }],
    ['dependentSchemas', { value: { type: 'string' } }],
    ['multipleOf', 1],
  ];

  for (const [keyword, value] of unsupportedKeywords) {
    const result = outputCompatibility({ type: 'string' }, { [keyword]: value });
    assert.ok(result.issues.some(
      (issue) => issue.path === `outputs[0].schema.${keyword}` && issue.message.endsWith('unsupported JSON Schema keyword'),
    ), keyword);
  }
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
