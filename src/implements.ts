import type { JsonSchema, WorkflowDef } from './types.ts';

/** A versioned external interface coordinate claimed in a workflow's x bag. */
export interface WorkflowInterfaceClaim {
  name: string;
  version: string;
}

/** A named input or public output and the schema that defines its values. */
export interface WorkflowInterfaceArtifact {
  name: string;
  schema?: JsonSchema;
}

/**
 * The typed portion of an external workflow interface. Its catalog coordinate
 * is deliberately separate: this checker compares a supplied signature and
 * does not resolve a hub catalog or decide whether the workflow authored a
 * matching x.implements claim.
 */
export interface WorkflowInterfaceSignature {
  inputs: WorkflowInterfaceArtifact[];
  outputs: WorkflowInterfaceArtifact[];
}

/** One deterministic reason an implementation does not satisfy an interface. */
export interface InterfaceCompatibilityIssue {
  path: string;
  message: string;
}

/** The pure result returned when a signature is checked against a workflow. */
export interface InterfaceCompatibilityCheck {
  compatible: boolean;
  issues: InterfaceCompatibilityIssue[];
}

type SchemaObject = Record<string, unknown>;
type Direction = 'input' | 'output';

const JSON_SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);

const ANNOTATION_KEYWORDS = new Set([
  'title',
  'description',
  'default',
  'examples',
  '$comment',
  '$id',
  '$schema',
  '$anchor',
  '$dynamicAnchor',
]);

/**
 * This is a syntax/value allowlist, not a guarantee that every accepted
 * composition can be structurally proved safe by schemaSubset.
 */
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'const',
  'enum',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'minProperties',
  'maxProperties',
  'properties',
  'required',
  'additionalProperties',
  'oneOf',
  'anyOf',
]);

function isMap(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === 'boolean' || isMap(value);
}

function joinPath(path: string, segment: string): string {
  return path === '' ? segment : path + '.' + segment;
}

function indexedPath(path: string, index: number): string {
  return path + '[' + index + ']';
}

function message(path: string, text: string): InterfaceCompatibilityIssue {
  return { path, message: path + ': ' + text };
}

function schemaObject(value: JsonSchema): SchemaObject | undefined {
  return typeof value === 'boolean' ? undefined : value;
}

function schemaAt(value: unknown, fallbackPath: string, issues: InterfaceCompatibilityIssue[]): JsonSchema | undefined {
  if (!isJsonSchema(value)) {
    issues.push(message(fallbackPath, 'expected a JSON Schema object or boolean'));
    return undefined;
  }
  return value;
}

function propertyMap(value: unknown, path: string, issues: InterfaceCompatibilityIssue[]): SchemaObject {
  if (value === undefined) return {};
  if (!isMap(value)) {
    issues.push(message(path, 'expected a map'));
    return {};
  }
  return value;
}

function stringSet(value: unknown, path: string, issues: InterfaceCompatibilityIssue[]): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    issues.push(message(path, 'expected an array of strings'));
    return new Set();
  }
  return new Set(value);
}

function typeSet(value: unknown, path: string, issues: InterfaceCompatibilityIssue[]): Set<string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && JSON_SCHEMA_TYPES.has(value)) return new Set([value]);
  if (
    Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && JSON_SCHEMA_TYPES.has(entry))
    && new Set(value).size === value.length
  ) return new Set(value);
  issues.push(message(path, 'expected a string or an array of strings'));
  return undefined;
}

function typeIsSubset(source: string, target: string): boolean {
  return source === target || (source === 'integer' && target === 'number');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (isMap(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function enumValues(value: unknown, path: string, issues: InterfaceCompatibilityIssue[]): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(message(path, 'expected a non-empty array'));
    return undefined;
  }
  return value;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isMap(value) && Object.values(value).every(isJsonValue);
}

function effectiveValues(schema: SchemaObject, path: string, issues: InterfaceCompatibilityIssue[]): unknown[] | undefined {
  const hasConst = Object.hasOwn(schema, 'const');
  const enumValue = enumValues(schema.enum, joinPath(path, 'enum'), issues);
  if (!hasConst && enumValue === undefined) return undefined;
  if (!hasConst) return enumValue;
  const constant = schema.const;
  if (enumValue === undefined) return [constant];
  const constantKey = stableJson(constant);
  return enumValue.some((value) => stableJson(value) === constantKey) ? [constant] : [];
}

type Bound = { value: number; exclusive: boolean };

function lowerBound(schema: SchemaObject, path: string, issues: InterfaceCompatibilityIssue[]): Bound | undefined {
  const minimum = schema.minimum;
  const exclusive = schema.exclusiveMinimum;
  if (minimum !== undefined && typeof minimum !== 'number') {
    issues.push(message(joinPath(path, 'minimum'), 'expected a number'));
  }
  if (exclusive !== undefined && typeof exclusive !== 'number') {
    issues.push(message(joinPath(path, 'exclusiveMinimum'), 'expected a number'));
  }
  const bounds: Bound[] = [];
  if (typeof minimum === 'number') bounds.push({ value: minimum, exclusive: false });
  if (typeof exclusive === 'number') bounds.push({ value: exclusive, exclusive: true });
  return bounds.reduce<Bound | undefined>((strictest, current) => {
    if (strictest === undefined || current.value > strictest.value) return current;
    if (current.value === strictest.value && current.exclusive) return current;
    return strictest;
  }, undefined);
}

function upperBound(schema: SchemaObject, path: string, issues: InterfaceCompatibilityIssue[]): Bound | undefined {
  const maximum = schema.maximum;
  const exclusive = schema.exclusiveMaximum;
  if (maximum !== undefined && typeof maximum !== 'number') {
    issues.push(message(joinPath(path, 'maximum'), 'expected a number'));
  }
  if (exclusive !== undefined && typeof exclusive !== 'number') {
    issues.push(message(joinPath(path, 'exclusiveMaximum'), 'expected a number'));
  }
  const bounds: Bound[] = [];
  if (typeof maximum === 'number') bounds.push({ value: maximum, exclusive: false });
  if (typeof exclusive === 'number') bounds.push({ value: exclusive, exclusive: true });
  return bounds.reduce<Bound | undefined>((strictest, current) => {
    if (strictest === undefined || current.value < strictest.value) return current;
    if (current.value === strictest.value && current.exclusive) return current;
    return strictest;
  }, undefined);
}

function sourceMeetsLower(source: Bound | undefined, target: Bound | undefined): boolean {
  if (target === undefined) return true;
  if (source === undefined) return false;
  return source.value > target.value || (source.value === target.value && (source.exclusive || !target.exclusive));
}

function sourceMeetsUpper(source: Bound | undefined, target: Bound | undefined): boolean {
  if (target === undefined) return true;
  if (source === undefined) return false;
  return source.value < target.value || (source.value === target.value && (source.exclusive || !target.exclusive));
}

function numberValue(value: unknown, path: string, issues: InterfaceCompatibilityIssue[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  issues.push(message(path, 'expected a number'));
  return undefined;
}

function sourceAtLeast(
  source: SchemaObject,
  target: SchemaObject,
  keyword: 'minLength' | 'minItems' | 'minProperties',
  path: string,
  issues: InterfaceCompatibilityIssue[],
): void {
  const targetValue = numberValue(target[keyword], joinPath(path, keyword), issues);
  if (targetValue === undefined) return;
  const sourceValue = numberValue(source[keyword], joinPath(path, keyword), issues);
  if (sourceValue === undefined || sourceValue < targetValue) {
    issues.push(message(joinPath(path, keyword), `source minimum ${sourceValue ?? 'unbounded'} does not satisfy target minimum ${targetValue}`));
  }
}

function sourceAtMost(
  source: SchemaObject,
  target: SchemaObject,
  keyword: 'maxLength' | 'maxItems' | 'maxProperties',
  path: string,
  issues: InterfaceCompatibilityIssue[],
): void {
  const targetValue = numberValue(target[keyword], joinPath(path, keyword), issues);
  if (targetValue === undefined) return;
  const sourceValue = numberValue(source[keyword], joinPath(path, keyword), issues);
  if (sourceValue === undefined || sourceValue > targetValue) {
    issues.push(message(joinPath(path, keyword), `source maximum ${sourceValue ?? 'unbounded'} does not satisfy target maximum ${targetValue}`));
  }
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validNonNegativeInteger(value: unknown): value is number {
  return validNumber(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Validate every supported keyword before subset comparison. buildDef accepts
 * a gross JSON Schema shape, so this checker must fail closed on malformed
 * supported values even when the opposite schema does not constrain them.
 */
function validateSchema(schema: JsonSchema, path: string, issues: InterfaceCompatibilityIssue[]): boolean {
  const object = schemaObject(schema);
  if (object === undefined) return true;
  let valid = true;
  for (const key of Object.keys(object)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      issues.push(message(joinPath(path, key), 'unsupported JSON Schema keyword'));
      valid = false;
      continue;
    }
    if (ANNOTATION_KEYWORDS.has(key)) continue;

    const value = object[key];
    const fieldPath = joinPath(path, key);
    switch (key) {
      case 'type':
	if (typeSet(value, fieldPath, issues) === undefined) valid = false;
	break;
      case 'const':
	if (!isJsonValue(value)) {
	  issues.push(message(fieldPath, 'expected a JSON value'));
	  valid = false;
	}
	break;
      case 'enum': {
	const entries = enumValues(value, fieldPath, issues);
	if (entries === undefined || entries.some((entry) => !isJsonValue(entry))) {
	  if (entries !== undefined && entries.some((entry) => !isJsonValue(entry))) {
	    issues.push(message(fieldPath, 'expected JSON values'));
	  }
	  valid = false;
	} else if (new Set(entries.map(stableJson)).size !== entries.length) {
	  issues.push(message(fieldPath, 'expected unique values'));
	  valid = false;
	}
	break;
      }
      case 'minimum':
      case 'maximum':
      case 'exclusiveMinimum':
      case 'exclusiveMaximum':
	if (!validNumber(value)) {
	  issues.push(message(fieldPath, 'expected a finite number'));
	  valid = false;
	}
	break;
      case 'minLength':
      case 'maxLength':
      case 'minItems':
      case 'maxItems':
      case 'minProperties':
      case 'maxProperties':
	if (!validNonNegativeInteger(value)) {
	  issues.push(message(fieldPath, 'expected a non-negative integer'));
	  valid = false;
	}
	break;
      case 'uniqueItems':
	if (typeof value !== 'boolean') {
	  issues.push(message(fieldPath, 'expected a boolean'));
	  valid = false;
	}
	break;
      case 'pattern':
	if (typeof value !== 'string') {
	  issues.push(message(fieldPath, 'expected a string'));
	  valid = false;
	} else {
	  try {
	    new RegExp(value, 'u');
	  } catch {
	    issues.push(message(fieldPath, 'expected a valid ECMA-262 Unicode regular expression'));
	    valid = false;
	  }
	}
	break;
      case 'format':
	if (typeof value !== 'string') {
	  issues.push(message(fieldPath, 'expected a string'));
	  valid = false;
	}
	break;
      case 'oneOf':
      case 'anyOf':
	if (!Array.isArray(value) || value.length === 0) {
	  issues.push(message(fieldPath, 'expected a non-empty array'));
	  valid = false;
	  break;
	}
	for (const [index, entry] of value.entries()) {
	  const branchPath = indexedPath(fieldPath, index);
	  const branch = schemaAt(entry, branchPath, issues);
	  if (branch === undefined || !validateSchema(branch, branchPath, issues)) valid = false;
	}
	break;
      case 'items': {
	const child = schemaAt(value, fieldPath, issues);
	if (child === undefined) valid = false;
	else if (!validateSchema(child, fieldPath, issues)) valid = false;
	break;
      }
      case 'properties':
	if (!isMap(value)) {
	  issues.push(message(fieldPath, 'expected a map'));
	  valid = false;
	  break;
	}
	for (const property of Object.keys(value)) {
	  const propertyPath = joinPath(fieldPath, property);
	  const child = schemaAt(value[property], propertyPath, issues);
	  if (child === undefined || !validateSchema(child, propertyPath, issues)) valid = false;
	}
	break;
      case 'required':
	if (
	  !Array.isArray(value)
	  || value.some((entry) => typeof entry !== 'string')
	  || new Set(value).size !== value.length
	) {
	  issues.push(message(fieldPath, 'expected an array of unique strings'));
	  valid = false;
	}
	break;
      case 'additionalProperties': {
	const child = schemaAt(value, fieldPath, issues);
	if (child === undefined) valid = false;
	else if (!validateSchema(child, fieldPath, issues)) valid = false;
	break;
      }
    }
  }
  return valid;
}

function additionalSchema(
  schema: SchemaObject,
  path: string,
  issues: InterfaceCompatibilityIssue[],
): JsonSchema {
  const value = schema.additionalProperties;
  if (value === undefined) return true;
  const parsed = schemaAt(value, joinPath(path, 'additionalProperties'), issues);
  return parsed ?? true;
}

function isClosed(schema: SchemaObject): boolean {
  return schema.additionalProperties === false;
}

const UNION_KEYWORDS = ['oneOf', 'anyOf'] as const;
type UnionKeyword = typeof UNION_KEYWORDS[number];

type UnionBranchSet = {
  keyword: UnionKeyword;
  branches: JsonSchema[];
};

function unionBranches(schema: SchemaObject, keyword: UnionKeyword): JsonSchema[] | undefined {
  const value = schema[keyword];
  if (!Array.isArray(value) || value.length === 0 || value.some((branch) => !isJsonSchema(branch))) return undefined;
  return value as JsonSchema[];
}

function unionBranchSets(schema: SchemaObject): UnionBranchSet[] {
  const sets: UnionBranchSet[] = [];
  for (const keyword of UNION_KEYWORDS) {
    const branches = unionBranches(schema, keyword);
    if (branches !== undefined) sets.push({ keyword, branches });
  }
  return sets;
}

function requiredNames(schema: SchemaObject): Set<string> {
  const required = schema.required;
  return Array.isArray(required) && required.every((name) => typeof name === 'string')
    ? new Set(required)
    : new Set();
}

function discriminatorValues(schema: JsonSchema): unknown[] | undefined {
  const object = schemaObject(schema);
  if (object === undefined) return undefined;
  return effectiveValues(object, 'discriminator', []);
}

function branchesAreDisjoint(source: JsonSchema, target: JsonSchema): boolean {
  const sourceObject = schemaObject(source);
  const targetObject = schemaObject(target);
  if (sourceObject === undefined || targetObject === undefined) return false;

  const sourceProperties = sourceObject.properties;
  const targetProperties = targetObject.properties;
  if (!isMap(sourceProperties) || !isMap(targetProperties)) return false;

  const sourceRequired = requiredNames(sourceObject);
  const targetRequired = requiredNames(targetObject);
  for (const property of Object.keys(sourceProperties)) {
    if (!sourceRequired.has(property) || !targetRequired.has(property) || !Object.hasOwn(targetProperties, property)) continue;
    const sourceValues = discriminatorValues(sourceProperties[property] as JsonSchema);
    const targetValues = discriminatorValues(targetProperties[property] as JsonSchema);
    if (sourceValues === undefined || targetValues === undefined) continue;
    const targetValueKeys = new Set(targetValues.map(stableJson));
    if (sourceValues.every((value) => !targetValueKeys.has(stableJson(value)))) return true;
  }
  return false;
}

function targetOneOfIsDisjoint(branches: JsonSchema[]): boolean {
  for (let left = 0; left < branches.length; left += 1) {
    for (let right = left + 1; right < branches.length; right += 1) {
      const leftBranch = branches[left];
      const rightBranch = branches[right];
      if (leftBranch === undefined || rightBranch === undefined || !branchesAreDisjoint(leftBranch, rightBranch)) return false;
    }
  }
  return true;
}

function isSubsetOfOneBranch(
  source: JsonSchema,
  targets: JsonSchema[],
  path: string,
  direction: Direction,
): boolean {
  return targets.some((target) => {
    const probeIssues: InterfaceCompatibilityIssue[] = [];
    schemaSubset(source, target, path, direction, probeIssues);
    return probeIssues.length === 0;
  });
}

function compareUnionObligations(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
  direction: Direction,
  issues: InterfaceCompatibilityIssue[],
): void {
  const sourceSets = unionBranchSets(source);
  const targetSets = unionBranchSets(target);

  if (targetSets.length === 0) {
    for (const sourceSet of sourceSets) {
      for (const [index, branch] of sourceSet.branches.entries()) {
	const branchPath = indexedPath(joinPath(path, sourceSet.keyword), index);
	if (!isSubsetOfOneBranch(branch, [target], branchPath, direction)) {
	  issues.push(message(branchPath, 'source union branch is not a subset of the target schema'));
	}
      }
    }
    return;
  }

  const sourceCandidates = sourceSets.length === 0
    ? [{ branches: [source as JsonSchema], path }]
    : sourceSets.map((set) => ({
	branches: set.branches,
	path: joinPath(path, set.keyword),
      }));

  for (const targetSet of targetSets) {
    const targetPath = joinPath(path, targetSet.keyword);
    if (targetSet.keyword === 'oneOf' && !targetOneOfIsDisjoint(targetSet.branches)) {
      issues.push(message(targetPath, 'target oneOf branches are not proven pairwise disjoint by required const/enum discriminators'));
      continue;
    }

    for (const sourceSet of sourceCandidates) {
      for (const [index, branch] of sourceSet.branches.entries()) {
	const branchPath = sourceSet.path === path ? targetPath : indexedPath(sourceSet.path, index);
	if (!isSubsetOfOneBranch(branch, targetSet.branches, branchPath, direction)) {
	  const sourceDescription = sourceSet.path === path ? 'source schema' : 'source union branch';
	  issues.push(message(branchPath, `${sourceDescription} is not a subset of any target ${targetSet.keyword} branch`));
	}
      }
    }
  }
}

/**
 * Checks whether every value admitted by source is admitted by target. Inputs
 * call it as interface → implementation (contravariance); public outputs call
 * it as implementation → interface (covariance).
 */
function schemaSubset(
  source: JsonSchema,
  target: JsonSchema,
  path: string,
  direction: Direction,
  issues: InterfaceCompatibilityIssue[],
): void {
  if (source === false || target === true) return;
  if (source === true) {
    issues.push(message(path, 'source schema accepts values the target schema does not prove it accepts'));
    return;
  }
  if (target === false) {
    issues.push(message(path, 'target schema rejects every value accepted by the source schema'));
    return;
  }

  const sourceTypes = typeSet(source.type, joinPath(path, 'source.type'), issues);
  const targetTypes = typeSet(target.type, joinPath(path, 'target.type'), issues);
  if (targetTypes !== undefined) {
    if (sourceTypes === undefined || [...sourceTypes].some((type) => ![...targetTypes].some((allowed) => typeIsSubset(type, allowed)))) {
      issues.push(message(joinPath(path, 'type'), 'source types are not a subset of target types'));
    }
  }

  const sourceValues = effectiveValues(source, joinPath(path, 'source'), issues);
  const targetValues = effectiveValues(target, path, issues);
  if (targetValues !== undefined) {
    const targetSet = new Set(targetValues.map(stableJson));
    if (sourceValues === undefined || sourceValues.some((value) => !targetSet.has(stableJson(value)))) {
      issues.push(message(joinPath(path, 'enum'), 'source allowed values are not a subset of target allowed values'));
    }
  }

  if (!sourceMeetsLower(lowerBound(source, path, issues), lowerBound(target, path, issues))) {
    issues.push(message(path, 'source numeric lower bound does not satisfy target lower bound'));
  }
  if (!sourceMeetsUpper(upperBound(source, path, issues), upperBound(target, path, issues))) {
    issues.push(message(path, 'source numeric upper bound does not satisfy target upper bound'));
  }

  sourceAtLeast(source, target, 'minLength', path, issues);
  sourceAtMost(source, target, 'maxLength', path, issues);
  sourceAtLeast(source, target, 'minItems', path, issues);
  sourceAtMost(source, target, 'maxItems', path, issues);
  if (target.uniqueItems === true && source.uniqueItems !== true) {
    issues.push(message(joinPath(path, 'uniqueItems'), 'source schema permits duplicate array items that the target forbids'));
  }
  const outputProjection = direction === 'output' && isClosed(target) && isClosed(source);
  if (!outputProjection) {
    sourceAtLeast(source, target, 'minProperties', path, issues);
    sourceAtMost(source, target, 'maxProperties', path, issues);
  }

  for (const keyword of ['pattern', 'format'] as const) {
    if (target[keyword] === undefined) continue;
    if (typeof target[keyword] !== 'string') {
      issues.push(message(joinPath(path, keyword), 'expected a string'));
      continue;
    }
    if (source[keyword] !== target[keyword]) {
      issues.push(message(joinPath(path, keyword), 'target constraint is not proven by the source schema'));
    }
  }

  if (target.items !== undefined) {
    const sourceItems = schemaAt(source.items ?? true, joinPath(path, 'source.items'), issues);
    const targetItems = schemaAt(target.items, joinPath(path, 'items'), issues);
    if (sourceItems !== undefined && targetItems !== undefined) {
      schemaSubset(sourceItems, targetItems, joinPath(path, 'items'), direction, issues);
    }
  }

  compareUnionObligations(source, target, path, direction, issues);
  compareObjects(source, target, path, direction, issues);
}

function compareObjects(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
  direction: Direction,
  issues: InterfaceCompatibilityIssue[],
): void {
  const sourceProperties = propertyMap(source.properties, joinPath(path, 'source.properties'), issues);
  const targetProperties = propertyMap(target.properties, joinPath(path, 'properties'), issues);
  const sourceRequired = stringSet(source.required, joinPath(path, 'source.required'), issues);
  const targetRequired = stringSet(target.required, joinPath(path, 'required'), issues);
  const sourceAdditional = additionalSchema(source, path, issues);
  const targetAdditional = additionalSchema(target, path, issues);
  const outputProjection = direction === 'output' && isClosed(target) && isClosed(source);

  if (outputProjection) {
    const visibleProperties = Object.keys(sourceProperties).filter((property) => Object.hasOwn(targetProperties, property));
    const implementationOnlyCount = Object.keys(sourceProperties).length - visibleProperties.length;
    const visibleRequiredCount = visibleProperties.filter((property) => sourceRequired.has(property)).length;
    const sourceMinimum = typeof source.minProperties === 'number' ? source.minProperties : 0;
    const projectedMinimum = Math.max(visibleRequiredCount, sourceMinimum - implementationOnlyCount, 0);
    const targetMinimum = typeof target.minProperties === 'number' ? target.minProperties : undefined;
    if (targetMinimum !== undefined && projectedMinimum < targetMinimum) {
	issues.push(message(
	  joinPath(path, 'minProperties'),
	  `projected source minimum ${projectedMinimum} does not satisfy target minimum ${targetMinimum}`,
	));
    }

    const targetMaximum = typeof target.maxProperties === 'number' ? target.maxProperties : undefined;
    const sourceMaximum = typeof source.maxProperties === 'number' ? source.maxProperties : Number.POSITIVE_INFINITY;
    const projectedMaximum = Math.min(visibleProperties.length, sourceMaximum);
    if (targetMaximum !== undefined && projectedMaximum > targetMaximum) {
	issues.push(message(
	  joinPath(path, 'maxProperties'),
	  `projected source maximum ${projectedMaximum} does not satisfy target maximum ${targetMaximum}`,
	));
    }
  }

  for (const property of targetRequired) {
    if (sourceRequired.has(property)) continue;
    if (direction === 'input') {
      issues.push(message(joinPath(path, 'required'), `implementation-only required property '${property}'`));
    } else {
      issues.push(message(joinPath(path, 'required'), `implementation must require interface property '${property}'`));
    }
  }

  for (const property of Object.keys(targetProperties)) {
    const targetPropertyPath = joinPath(joinPath(path, 'properties'), property);
    const targetProperty = schemaAt(targetProperties[property], targetPropertyPath, issues);
    if (targetProperty === undefined) continue;
    const sourceProperty = sourceProperties[property];
    if (sourceProperty !== undefined) {
      const parsedSource = schemaAt(sourceProperty, targetPropertyPath, issues);
      if (parsedSource !== undefined) schemaSubset(parsedSource, targetProperty, targetPropertyPath, direction, issues);
      continue;
    }
    if (direction === 'output') {
      issues.push(message(targetPropertyPath, `implementation output is missing interface property '${property}'`));
      continue;
    }
    if (sourceAdditional !== false) {
      schemaSubset(sourceAdditional, targetProperty, targetPropertyPath, direction, issues);
    }
  }

  for (const property of Object.keys(sourceProperties)) {
    if (Object.hasOwn(targetProperties, property)) continue;
    if (outputProjection) continue;
    const sourcePropertyPath = joinPath(joinPath(path, 'properties'), property);
    const sourceProperty = schemaAt(sourceProperties[property], sourcePropertyPath, issues);
    if (sourceProperty !== undefined) schemaSubset(sourceProperty, targetAdditional, sourcePropertyPath, direction, issues);
  }

  if (direction === 'output' && isClosed(target) && !isClosed(source)) {
    issues.push(message(joinPath(path, 'additionalProperties'), 'implementation has an unprovable open-property surface for a closed interface output'));
    return;
  }
  if (!outputProjection) {
    schemaSubset(sourceAdditional, targetAdditional, joinPath(path, 'additionalProperties'), direction, issues);
  }
}

function artifacts(value: unknown, path: string, issues: InterfaceCompatibilityIssue[]): WorkflowInterfaceArtifact[] {
  if (!Array.isArray(value)) {
    issues.push(message(path, 'expected an array'));
    return [];
  }
  return value as WorkflowInterfaceArtifact[];
}

function publicOutput(def: WorkflowDef, name: string): JsonSchema | undefined {
  if (!(def.outputs ?? []).includes(name)) return undefined;
  for (const step of def.steps) {
    const artifact = [...step.produces, ...(step.generates ?? [])].find((produce) => produce.stem === name);
    if (artifact !== undefined) return artifact.schema;
  }
  return undefined;
}

/**
 * Validate a workflow against a supplied external interface signature without
 * mutating either value. x.discovery.interface remains the definition's
 * self-description and owns local schemaRef pointers; x.implements only names
 * external contracts and carries no copied schemas or second pointer syntax.
 *
 * This is structural JSON Schema compatibility, not a general theorem prover.
 * It supports booleans; type/const/enum; numeric, string, array, and object
 * bounds; array items and uniqueItems; object properties, required, and
 * additionalProperties; and oneOf/anyOf. Union sibling constraints are
 * compared separately from branch coverage. Target oneOf branches are accepted
 * only when required const/enum discriminators prove every pair disjoint.
 * The checker remains structural and incomplete: coverage requiring multiple
 * target branches fails closed. allOf, if/then/else, not, $ref, prefixItems,
 * and other validation keywords fail closed with a path-specific issue. For a
 * closed interface output, the projection rule permits extra implementation
 * properties only when that implementation is also closed.
 */
export function checkInterfaceCompatibility(
  signature: WorkflowInterfaceSignature,
  def: WorkflowDef,
): InterfaceCompatibilityCheck {
  const issues: InterfaceCompatibilityIssue[] = [];
  const inputs = artifacts(signature.inputs, 'inputs', issues);
  const outputs = artifacts(signature.outputs, 'outputs', issues);
  const interfaceInputNames = new Set<string>();

  for (const [index, artifact] of inputs.entries()) {
    const path = `inputs[${index}]`;
    if (!isMap(artifact) || typeof artifact.name !== 'string' || artifact.name.trim() === '') {
      issues.push(message(joinPath(path, 'name'), 'expected a non-empty string'));
      continue;
    }
    interfaceInputNames.add(artifact.name);
    const interfaceSchema = schemaAt(artifact.schema, joinPath(path, 'schema'), issues);
    const implementation = def.inputs.find((input) => input.name === artifact.name);
    if (implementation === undefined) {
      issues.push(message(joinPath(path, 'name'), `workflow does not declare interface input '${artifact.name}'`));
      continue;
    }
    const implementationSchema = schemaAt(implementation.schema, `inputs.${artifact.name}.schema`, issues);
    if (interfaceSchema === undefined || implementationSchema === undefined) continue;
    const validInterfaceSchema = validateSchema(interfaceSchema, joinPath(path, 'schema'), issues);
    const validImplementationSchema = validateSchema(implementationSchema, `inputs.${artifact.name}.schema`, issues);
    if (validInterfaceSchema && validImplementationSchema) {
      schemaSubset(interfaceSchema, implementationSchema, `inputs.${artifact.name}.schema`, 'input', issues);
    }
  }

  for (const input of def.inputs) {
    if (!interfaceInputNames.has(input.name)) {
      issues.push(message(`inputs.${input.name}`, `workflow declares additional input '${input.name}' not in the interface`));
    }
  }

  for (const [index, artifact] of outputs.entries()) {
    const path = `outputs[${index}]`;
    if (!isMap(artifact) || typeof artifact.name !== 'string' || artifact.name.trim() === '') {
      issues.push(message(joinPath(path, 'name'), 'expected a non-empty string'));
      continue;
    }
    const interfaceSchema = schemaAt(artifact.schema, joinPath(path, 'schema'), issues);
    const implementationSchema = publicOutput(def, artifact.name);
    if (implementationSchema === undefined) {
      issues.push(message(joinPath(path, 'name'), `workflow does not declare public output '${artifact.name}' with a schema`));
      continue;
    }
    if (interfaceSchema === undefined) continue;
    const validInterfaceSchema = validateSchema(interfaceSchema, joinPath(path, 'schema'), issues);
    const validImplementationSchema = validateSchema(implementationSchema, `outputs.${artifact.name}.schema`, issues);
    if (validInterfaceSchema && validImplementationSchema) {
      schemaSubset(implementationSchema, interfaceSchema, `outputs.${artifact.name}.schema`, 'output', issues);
    }
  }

  return { compatible: issues.length === 0, issues };
}

/**
 * Return advisory, field-qualified authoring issues for x.implements. The
 * extension remains optional so old binaries keep loading existing definitions.
 */
export function implementsIssues(def: WorkflowDef): string[] {
  const value = def.x?.implements;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) return ['x.implements: expected a non-empty array'];

  const issues: string[] = [];
  const coordinates = new Map<string, Set<string>>();
  for (const [index, claim] of value.entries()) {
    const path = `x.implements[${index}]`;
    if (!isMap(claim)) {
      issues.push(path + ': expected a map');
      continue;
    }
    const present = new Set<string>();
    for (const key of Object.keys(claim)) {
      if (key !== 'name' && key !== 'version') {
	issues.push(path + '.' + key + ': unknown field');
	continue;
      }
      present.add(key);
    }
    const name = claim.name;
    const version = claim.version;
    if (!present.has('name') || typeof name !== 'string' || name.trim() === '') {
      issues.push(path + '.name: expected a non-empty string');
    }
    if (!present.has('version') || typeof version !== 'string' || version.trim() === '') {
      issues.push(path + '.version: expected a non-empty string');
    }
    if (typeof name === 'string' && name.trim() !== '' && typeof version === 'string' && version.trim() !== '') {
      const versions = coordinates.get(name);
      if (versions?.has(version)) {
	issues.push(path + ': duplicate interface claim ' + name + '@' + version);
      } else if (versions) {
	versions.add(version);
      } else {
	coordinates.set(name, new Set([version]));
      }
    }
  }
  return issues;
}
