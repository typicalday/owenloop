/**
 * The wire-contract drift check has two independent layers:
 *
 * 1. `as const satisfies FieldManifest<T>` in `src/crypto/records.ts` pins each
 *    manifest to its TypeScript shape at compile time.
 * 2. This test pins each checked-in JSON Schema to the same manifest, then
 *    validates canonical valid and invalid vectors through the engine's existing
 *    draft-2020-12 validator.
 *
 * The schema is deliberately not generated from TypeScript (and TypeScript is
 * not generated from the schema). Generation would repair the mismatch that CI
 * is meant to detect. The fixtures also ensure the schemas validate real values,
 * rather than passing only because both sides are empty.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonSchema } from '../src/types.ts';
import { DSSE_RECORD_PAYLOAD_TYPES } from '../src/crypto/dsse.ts';
import {
  ENROLLMENT_GRANT_FIELDS,
  ENROLLMENT_KEY_FIELDS,
  GRANT_DELEGATION_ALLOWED_FIELDS,
  GRANT_DELEGATION_DENIED_FIELDS,
  GRANT_SCOPE_FIELDS,
  ORDER_FIELDS,
  ORDER_OWED_FIELDS,
  ORDER_REASON_FIELDS,
  ORIGIN_FIELDS,
  ORIGIN_SOURCE_AGENT_FIELDS,
  ORIGIN_SOURCE_CONSOLE_FIELDS,
  ORIGIN_SOURCE_GIT_FIELDS,
  POLICY_FLOOR_FIELDS,
  POLICY_FLOOR_RECORD_FIELDS,
  PRINCIPAL_REFERENCE_FIELDS,
  PUBLICATION_FIELDS,
  RECORD_PAYLOAD_TYPES,
  REVOCATION_FIELDS,
  SUBMISSION_FIELDS,
  SUBMISSION_PRODUCED_FIELDS,
} from '../src/crypto/records.ts';
import {
  enrollmentGrantSchema,
  orderSchema,
  originSchema,
  policyFloorSchema,
  publicationSchema,
  revocationSchema,
  submissionSchema,
} from '../src/schemas/index.ts';
import { validateValue } from '../src/schema.ts';
import enrollmentGrantFixtures from './fixtures/wire/enrollment-grant.json' with { type: 'json' };
import orderFixtures from './fixtures/wire/order.json' with { type: 'json' };
import originFixtures from './fixtures/wire/origin.json' with { type: 'json' };
import policyFloorFixtures from './fixtures/wire/policy-floor.json' with { type: 'json' };
import publicationFixtures from './fixtures/wire/publication.json' with { type: 'json' };
import revocationFixtures from './fixtures/wire/revocation.json' with { type: 'json' };
import submissionFixtures from './fixtures/wire/submission.json' with { type: 'json' };

type Manifest = Readonly<Record<string, 'required' | 'optional'>>;

type FixtureCase = {
  name: string;
  value: unknown;
  keyword: string;
};

type FixtureSet = {
  valid: unknown;
  additionalValid?: unknown[];
  invalid: FixtureCase[];
  verificationInvalid?: Array<{ name: string; value: unknown }>;
};

type Contract = {
  name: string;
  schema: JsonSchema;
  manifest: Manifest;
  fixtures: FixtureSet;
};

const contracts: Contract[] = [
  {
    name: 'submission',
    schema: submissionSchema,
    manifest: SUBMISSION_FIELDS,
    fixtures: submissionFixtures as FixtureSet,
  },
  {
    name: 'enrollment grant',
    schema: enrollmentGrantSchema,
    manifest: ENROLLMENT_GRANT_FIELDS,
    fixtures: enrollmentGrantFixtures as FixtureSet,
  },
  {
    name: 'revocation',
    schema: revocationSchema,
    manifest: REVOCATION_FIELDS,
    fixtures: revocationFixtures as FixtureSet,
  },
  {
    name: 'policy floor',
    schema: policyFloorSchema,
    manifest: POLICY_FLOOR_RECORD_FIELDS,
    fixtures: policyFloorFixtures as FixtureSet,
  },
  {
    name: 'publication',
    schema: publicationSchema,
    manifest: PUBLICATION_FIELDS,
    fixtures: publicationFixtures as FixtureSet,
  },
  {
    name: 'origin',
    schema: originSchema,
    manifest: ORIGIN_FIELDS,
    fixtures: originFixtures as FixtureSet,
  },
  {
    name: 'order',
    schema: orderSchema,
    manifest: ORDER_FIELDS,
    fixtures: orderFixtures as FixtureSet,
  },
];

function objectSchema(schema: JsonSchema, label: string): Record<string, unknown> {
  assert.equal(typeof schema, 'object', `${label} must be an object schema`);
  assert.notEqual(schema, null, `${label} must not be null`);
  assert.equal(Array.isArray(schema), false, `${label} must not be an array schema`);
  return schema as Record<string, unknown>;
}

function propertiesOf(schema: JsonSchema, label: string): Record<string, JsonSchema> {
  const value = objectSchema(schema, label).properties;
  assert.equal(typeof value, 'object', `${label}.properties must be an object`);
  assert.notEqual(value, null, `${label}.properties must not be null`);
  assert.equal(Array.isArray(value), false, `${label}.properties must not be an array`);
  return value as Record<string, JsonSchema>;
}

function requiredOf(schema: JsonSchema, label: string): string[] {
  const value = objectSchema(schema, label).required;
  assert.ok(Array.isArray(value), `${label}.required must be an array`);
  assert.ok(value.every((entry): entry is string => typeof entry === 'string'), `${label}.required must contain strings`);
  return value as string[];
}

function propertyOf(schema: JsonSchema, property: string, label: string): JsonSchema {
  const value = propertiesOf(schema, label)[property];
  if (value === undefined) assert.fail(`${label} must define property ${property}`);
  return value;
}

function itemsOf(schema: JsonSchema, label: string): JsonSchema {
  const value = objectSchema(schema, label).items;
  assert.notEqual(value, undefined, `${label}.items must be defined`);
  return value as JsonSchema;
}

function oneOfOf(schema: JsonSchema, label: string): JsonSchema[] {
  const value = objectSchema(schema, label).oneOf;
  assert.ok(Array.isArray(value), `${label}.oneOf must be an array`);
  return value as JsonSchema[];
}

function assertManifestMatchesSchema(schema: JsonSchema, manifest: Manifest, label: string): void {
  const schemaProperties = Object.keys(propertiesOf(schema, label)).sort();
  const manifestProperties = Object.keys(manifest).sort();
  assert.deepEqual(schemaProperties, manifestProperties, `${label} properties must match its field manifest`);

  const schemaRequired = [...requiredOf(schema, label)].sort();
  const manifestRequired = Object.entries(manifest)
    .filter(([, presence]) => presence === 'required')
    .map(([field]) => field)
    .sort();
  assert.deepEqual(schemaRequired, manifestRequired, `${label} required fields must match its field manifest`);
}

const OPEN_OBJECT_POINTERS = new Set([
  '#/properties/consumedFingerprint',
  '#/properties/spec',
  '#/properties/x',
  '#/properties/consumes',
]);

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Every closed object is explicit; only named open maps may accept extra keys. */
function assertClosedObjects(schema: unknown, pointer: string): void {
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => assertClosedObjects(entry, `${pointer}/${index}`));
    return;
  }
  if (typeof schema !== 'object' || schema === null) return;

  const node = schema as Record<string, unknown>;
  if (node.type === 'object') {
    const exempt = OPEN_OBJECT_POINTERS.has(pointer);
    if (!exempt) {
      assert.equal(node.additionalProperties, false, `${pointer} must close additional properties`);
      assert.equal(
        node.patternProperties,
        undefined,
        `${pointer} must not define patternProperties on a closed object`,
      );
    } else {
      assert.notEqual(node.additionalProperties, false, `${pointer} is an explicitly open map`);
    }

    const properties = node.properties;
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        assertClosedObjects(child, `${pointer}/properties/${escapeJsonPointer(name)}`);
      }
    }
  }

  for (const key of ['items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', '$defs']) {
    const child = node[key];
    if (child !== undefined && !(key === 'additionalProperties' && child === false)) {
      assertClosedObjects(child, `${pointer}/${key}`);
    }
  }
}

function revocationTemporalConsistency(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.issuedAt === 'number' &&
    typeof record.effectiveFrom === 'number' &&
    typeof record.backdated === 'boolean' &&
    record.backdated === (record.effectiveFrom < record.issuedAt)
  );
}

test('wire schemas are non-vacuous and match their top-level manifests', () => {
  for (const contract of contracts) {
    const schemaObjectValue = objectSchema(contract.schema, contract.name);
    assert.equal(typeof schemaObjectValue.$id, 'string', `${contract.name} must carry a stable $id`);
    assert.ok(Object.keys(contract.manifest).length > 0, `${contract.name} manifest must not be empty`);
    assert.ok(requiredOf(contract.schema, contract.name).length > 0, `${contract.name} must require at least one field`);
    assertManifestMatchesSchema(contract.schema, contract.manifest, contract.name);
  }
});

test('nested wire shapes are pinned by the same manifests', () => {
  assertManifestMatchesSchema(
    itemsOf(propertyOf(submissionSchema, 'produced', 'submission'), 'submission.produced'),
    SUBMISSION_PRODUCED_FIELDS,
    'submission.produced[]',
  );

  assertManifestMatchesSchema(
    propertyOf(enrollmentGrantSchema, 'newKey', 'enrollment grant'),
    ENROLLMENT_KEY_FIELDS,
    'enrollment grant.newKey',
  );
  assertManifestMatchesSchema(
    propertyOf(enrollmentGrantSchema, 'principal', 'enrollment grant'),
    PRINCIPAL_REFERENCE_FIELDS,
    'enrollment grant.principal',
  );
  const enrollmentScope = propertyOf(enrollmentGrantSchema, 'scope', 'enrollment grant');
  assertManifestMatchesSchema(enrollmentScope, GRANT_SCOPE_FIELDS, 'enrollment grant.scope');
  const enrollmentDelegation = propertyOf(enrollmentScope, 'delegation', 'enrollment grant.scope');
  const delegationBranches = oneOfOf(enrollmentDelegation, 'enrollment grant.scope.delegation');
  assertManifestMatchesSchema(
    delegationBranches[0]!,
    GRANT_DELEGATION_DENIED_FIELDS,
    'enrollment grant.scope.delegation[denied]',
  );
  assertManifestMatchesSchema(
    delegationBranches[1]!,
    GRANT_DELEGATION_ALLOWED_FIELDS,
    'enrollment grant.scope.delegation[allowed]',
  );
  const originSourceBranches = oneOfOf(propertyOf(originSchema, 'source', 'origin'), 'origin.source');
  assertManifestMatchesSchema(originSourceBranches[0]!, ORIGIN_SOURCE_GIT_FIELDS, 'origin.source[git]');
  assertManifestMatchesSchema(originSourceBranches[1]!, ORIGIN_SOURCE_CONSOLE_FIELDS, 'origin.source[console]');
  assertManifestMatchesSchema(originSourceBranches[2]!, ORIGIN_SOURCE_AGENT_FIELDS, 'origin.source[agent]');

  assertManifestMatchesSchema(
    propertyOf(revocationSchema, 'principal', 'revocation'),
    PRINCIPAL_REFERENCE_FIELDS,
    'revocation.principal',
  );

  assertManifestMatchesSchema(
    propertyOf(policyFloorSchema, 'floor', 'policy floor'),
    POLICY_FLOOR_FIELDS,
    'policy floor.floor',
  );
  const owed = itemsOf(propertyOf(orderSchema, 'owes', 'order'), 'order.owes');
  assertManifestMatchesSchema(owed, ORDER_OWED_FIELDS, 'order.owes[]');
  assertManifestMatchesSchema(
    itemsOf(propertyOf(owed, 'reasons', 'order.owes[]'), 'order.owes[].reasons'),
    ORDER_REASON_FIELDS,
    'order.owes[].reasons[]',
  );
});

test('all object schemas close fields except named open maps', () => {
  for (const contract of contracts) assertClosedObjects(contract.schema, '#');
});

test('closed object schemas reject patternProperties', () => {
  assert.throws(
    () =>
      assertClosedObjects(
        {
          type: 'object',
          additionalProperties: false,
          patternProperties: { '^secret_': { type: 'string' } },
        },
        '#',
      ),
    /patternProperties/,
  );
});

for (const contract of contracts) {
  test(`${contract.name} validates canonical vectors and rejects malformed vectors`, () => {
    assert.equal(validateValue(contract.schema, contract.fixtures.valid).valid, true, `${contract.name} valid fixture`);
    for (const additional of contract.fixtures.additionalValid ?? []) {
      assert.equal(validateValue(contract.schema, additional).valid, true, `${contract.name} additional valid fixture`);
    }
    for (const invalid of contract.fixtures.invalid) {
      const result = validateValue(contract.schema, invalid.value);
      assert.equal(result.valid, false, `${contract.name}/${invalid.name} must fail validation`);
      assert.ok(
        result.issues.some((issue) => issue.keyword === invalid.keyword),
        `${contract.name}/${invalid.name} must fail on ${invalid.keyword}; got ${result.issues.map((issue) => issue.keyword).join(', ')}`,
      );
    }
  });
}

test('revocation timestamp intent is checked separately from JSON Schema', () => {
  const fixtures = revocationFixtures as FixtureSet;
  assert.equal(revocationTemporalConsistency(fixtures.valid), true, 'valid forward cut is self-consistent');
  for (const invalid of fixtures.verificationInvalid ?? []) {
    assert.equal(validateValue(revocationSchema, invalid.value).valid, true, `${invalid.name} has valid structural shape`);
    assert.equal(revocationTemporalConsistency(invalid.value), false, `${invalid.name} must fail the cross-field rule`);
  }
});

test('record payload bindings cover every defined record', () => {
  const boundPayloadTypes = new Set<string>(Object.values(RECORD_PAYLOAD_TYPES));
  for (const payloadType of DSSE_RECORD_PAYLOAD_TYPES) {
    assert.ok(boundPayloadTypes.has(payloadType), `${payloadType} must have a record binding`);
  }
  assert.equal(boundPayloadTypes.size, DSSE_RECORD_PAYLOAD_TYPES.length);
});
