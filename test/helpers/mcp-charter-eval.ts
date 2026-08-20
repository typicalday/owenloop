import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createMcpServer, textResult } from '../../src/mcp/server.ts';
import type { McpServer, McpServerOptions, ToolRegistration } from '../../src/mcp/server.ts';

export const DEFAULT_CHARTER_FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/mcp-charter-eval.json', import.meta.url),
);

export type TaskKind = 'match' | 'no-match' | 'ambiguous';

export interface WorkflowInputSchema {
  name: string;
  schema?: unknown;
  [key: string]: unknown;
}

export interface WorkflowDefinition {
  name: string;
  title: string;
  description: string;
  inputs: string[];
  inputSchemas: WorkflowInputSchema[];
  x: Record<string, unknown> & { discovery: Record<string, unknown> };
}

export interface CharterTask {
  id: string;
  kind: TaskKind;
  request: string;
  expectedWorkflow?: string;
}

export interface CharterFixture {
  version: number;
  catalog: WorkflowDefinition[];
  tasks: CharterTask[];
}

export interface TraceInitialization {
  kind: 'initialize';
  charterSha256: string;
}

export interface TraceCall {
  sequence: number;
  name: string;
  arguments: unknown;
}

export type ParsedTrace =
  | { status: 'scorable'; charterSha256: string; calls: TraceCall[] }
  | { status: 'unscorable'; reason: string; calls: TraceCall[] };

export type TaskClassification = 'passed' | 'failed' | 'observed' | 'unscorable';

export interface ScoredTask {
  id: string;
  kind: TaskKind;
  request: string;
  expectedWorkflow?: string;
  classification: TaskClassification;
  passed?: boolean;
  reason?: string;
  calls: TraceCall[];
}

export interface TaskRecord extends ScoredTask {
  responseEvidence: string[];
}

export interface ScoreRecord {
  harness: {
    id: string;
    configuredModel?: string;
    reportedModel?: string;
    version?: string;
  };
  charterSha256: string;
  passed: number;
  denominator: number;
  percentage: number;
  tasks: TaskRecord[];
}

export interface CharterEvalReport {
  schemaVersion: 1;
  generatedAt: string;
  nodeVersion: string;
  fixture: {
    version: number;
    catalogDigest: string;
  };
  scores: ScoreRecord[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`fixture ${field} must be a non-empty string`);
  return value;
}

function asRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`fixture ${field} must be an object`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`fixture ${field} must be a string array`);
  }
  return value;
}

function asInputSchemas(value: unknown, field: string): WorkflowInputSchema[] {
  if (!Array.isArray(value)) throw new Error(`fixture ${field} must be an array`);
  return value.map((entry, index) => {
    const record = asRecord(entry, `${field}[${index}]`);
    return { ...record, name: asString(record['name'], `${field}[${index}].name`) };
  });
}

function parseWorkflow(value: unknown, index: number): WorkflowDefinition {
  const record = asRecord(value, `catalog[${index}]`);
  const extension = asRecord(record['x'], `catalog[${index}].x`);
  return {
    name: asString(record['name'], `catalog[${index}].name`),
    title: asString(record['title'], `catalog[${index}].title`),
    description: asString(record['description'], `catalog[${index}].description`),
    inputs: asStringArray(record['inputs'], `catalog[${index}].inputs`),
    inputSchemas: asInputSchemas(record['inputSchemas'], `catalog[${index}].inputSchemas`),
    x: {
      ...extension,
      discovery: asRecord(extension['discovery'], `catalog[${index}].x.discovery`),
    },
  };
}

function parseTask(value: unknown, index: number): CharterTask {
  const record = asRecord(value, `tasks[${index}]`);
  const kind = asString(record['kind'], `tasks[${index}].kind`);
  if (kind !== 'match' && kind !== 'no-match' && kind !== 'ambiguous') {
    throw new Error(`fixture tasks[${index}].kind must be match, no-match, or ambiguous`);
  }
  const expectedWorkflow = record['expectedWorkflow'];
  if (kind === 'match' && typeof expectedWorkflow !== 'string') {
    throw new Error(`fixture tasks[${index}].expectedWorkflow is required for a match task`);
  }
  if (expectedWorkflow !== undefined && typeof expectedWorkflow !== 'string') {
    throw new Error(`fixture tasks[${index}].expectedWorkflow must be a string when present`);
  }
  return {
    id: asString(record['id'], `tasks[${index}].id`),
    kind,
    request: asString(record['request'], `tasks[${index}].request`),
    ...(expectedWorkflow === undefined ? {} : { expectedWorkflow }),
  };
}

/** Load and type-check the fixed, versioned catalog and canned task suite. */
export async function loadCharterFixture(path = DEFAULT_CHARTER_FIXTURE_PATH): Promise<CharterFixture> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const record = asRecord(parsed, 'root');
  if (!Number.isInteger(record['version'])) throw new Error('fixture version must be an integer');
  if (!Array.isArray(record['catalog']) || !Array.isArray(record['tasks'])) {
    throw new Error('fixture catalog and tasks must be arrays');
  }
  const fixture: CharterFixture = {
    version: record['version'] as number,
    catalog: record['catalog'].map(parseWorkflow),
    tasks: record['tasks'].map(parseTask),
  };
  const names = new Set(fixture.catalog.map((entry) => entry.name));
  const ids = new Set(fixture.tasks.map((task) => task.id));
  if (names.size !== fixture.catalog.length) throw new Error('fixture catalog workflow names must be unique');
  if (ids.size !== fixture.tasks.length) throw new Error('fixture task ids must be unique');
  for (const task of fixture.tasks) {
    if (task.expectedWorkflow !== undefined && !names.has(task.expectedWorkflow)) {
      throw new Error(`fixture task ${task.id} names unknown workflow ${task.expectedWorkflow}`);
    }
  }
  return fixture;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function catalogDigest(fixture: CharterFixture): string {
  return sha256(JSON.stringify(fixture.catalog));
}

/** Obtain the exact charter bytes served on a real initialize response. */
export async function servedCharterInstructions(): Promise<string> {
  const frames: unknown[] = [];
  const server = createMcpServer({
    name: 'mcp-charter-eval-probe',
    version: '0.0.0',
    tools: [],
    write: (frame) => frames.push(frame),
  });
  await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  );
  const first = asRecord(frames[0], 'initialize frame');
  const result = asRecord(first['result'], 'initialize result');
  return asString(result['instructions'], 'initialize instructions');
}

export async function servedCharterSha256(): Promise<string> {
  return sha256(await servedCharterInstructions());
}

export type FixtureCallRecorder = (name: string, arguments_: unknown) => void;

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

export const FIXTURE_NO_OP_TOOL_NAMES = [
  'submit',
  'wake',
  'whats_next',
  'provide_input',
  'retry_artifact',
  'reject_artifact',
] as const;

type FixtureNoOpToolName = (typeof FIXTURE_NO_OP_TOOL_NAMES)[number];

/**
 * These schemas deliberately mirror the production MCP surface. The handlers
 * remain local no-ops, but a model must see and be able to send the same
 * arguments it would use against Owenloop rather than an empty eval-only shape.
 */
const NO_OP_SCHEMAS: Readonly<Record<FixtureNoOpToolName, Record<string, unknown>>> = {
  whats_next: {
    type: 'object',
    properties: {
      workflow: { type: 'string' },
      serve_crews: { type: 'array', items: { type: 'string' } },
      serve_capabilities: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Raw capability keys this caller serves (bare names and exact compounds). ' +
          'Shifts derive them from their effective rosters; other callers normally omit them.',
      },
    },
    additionalProperties: false,
  },
  submit: {
    type: 'object',
    properties: {
      workflow: { type: 'string' },
      run: { type: 'string' },
      path: { type: 'string' },
      value: { type: 'object', additionalProperties: true },
      done: { type: 'boolean' },
    },
    required: ['workflow', 'run', 'path', 'value'],
    additionalProperties: false,
  },
  reject_artifact: {
    type: 'object',
    properties: {
      workflow: { type: 'string' },
      path: { type: 'string' },
      reason: { type: 'string' },
      requested: { type: 'string' },
    },
    required: ['workflow', 'path', 'reason'],
    additionalProperties: false,
  },
  retry_artifact: {
    type: 'object',
    properties: { workflow: { type: 'string' }, path: { type: 'string' }, text: { type: 'string' } },
    required: ['workflow', 'path'],
    additionalProperties: false,
  },
  provide_input: {
    type: 'object',
    properties: {
      workflow: { type: 'string' },
      name: { type: 'string' },
      value: { type: 'object', additionalProperties: true },
    },
    required: ['workflow', 'name', 'value'],
    additionalProperties: false,
  },
  wake: {
    type: 'object',
    properties: { cursor: { type: 'integer', minimum: 0 } },
    additionalProperties: false,
  },
};

function fixtureTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  result: (arguments_: Record<string, unknown>) => unknown,
): ToolRegistration {
  return {
    name,
    description,
    inputSchema,
    handler: (arguments_) => {
      const value = result(arguments_);
      return textResult(value, isRecord(value) && value['error'] !== undefined);
    },
  };
}

/**
 * The local-only tool set used by both the fixture process and deterministic
 * tests. It deliberately has no hub, CLI, REST, credential, or settings import.
 */
export function fixtureToolRegistrations(fixture: CharterFixture): ToolRegistration[] {
  const byName = new Map(fixture.catalog.map((definition) => [definition.name, definition]));
  const noOp = (name: FixtureNoOpToolName): ToolRegistration =>
    fixtureTool(name, `Local fixture implementation of ${name}.`, NO_OP_SCHEMAS[name], () => ({
      recorded: true,
      fixture: true,
      name,
    }));

  return [
    fixtureTool(
      'list_workflows',
      'List the fixed local evaluation catalog.',
      EMPTY_SCHEMA,
      () => ({ workflows: fixture.catalog }),
    ),
    fixtureTool(
      'get_workflow',
      'Get one fixed local evaluation workflow definition.',
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      (arguments_) => {
        const name = arguments_['name'];
        const definition = typeof name === 'string' ? byName.get(name) : undefined;
        return definition === undefined ? { error: `unknown fixture workflow ${String(name)}` } : definition;
      },
    ),
    fixtureTool(
      'start_run',
      'Record a selected fixed local evaluation workflow without executing it.',
      {
        type: 'object',
        properties: {
          workflow_name: { type: 'string' },
          provide: { type: 'object', additionalProperties: true },
          scope: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        },
        required: ['workflow_name'],
        additionalProperties: false,
      },
      (arguments_) => {
        const workflowName = arguments_['workflow_name'];
        if (typeof workflowName !== 'string' || !byName.has(workflowName)) {
          return { error: `unknown fixture workflow ${String(workflowName)}` };
        }
        return { recorded: true, workflow_name: workflowName, ...arguments_ };
      },
    ),
    noOp('submit'),
    noOp('wake'),
    noOp('whats_next'),
    noOp('provide_input'),
    noOp('retry_artifact'),
    noOp('reject_artifact'),
  ];
}

function receivedFixtureCall(line: string): { name: string; arguments: unknown } | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(frame) || frame['method'] !== 'tools/call') return undefined;
  const params = frame['params'];
  if (!isRecord(params) || typeof params['name'] !== 'string') return undefined;
  return {
    name: params['name'],
    // Match the real dispatcher: omitted arguments mean {}, while a supplied
    // malformed value is preserved exactly so its rejected call still counts.
    arguments: Object.hasOwn(params, 'arguments') ? params['arguments'] : {},
  };
}

/**
 * Build the fixture MCP server with tracing at the inbound wire boundary.
 * Recording before the real dispatcher runs ensures schema-rejected and
 * unknown named calls remain visible without double-recording valid handlers.
 */
export function createFixtureMcpServer(
  fixture: CharterFixture,
  opts: Omit<McpServerOptions, 'tools'> & { record: FixtureCallRecorder },
): McpServer {
  const { record, ...serverOptions } = opts;
  const core = createMcpServer({ ...serverOptions, tools: fixtureToolRegistrations(fixture) });
  return {
    handleLine(line) {
      const call = receivedFixtureCall(line);
      if (call !== undefined) record(call.name, call.arguments);
      return core.handleLine(line);
    },
    close(reason) {
      core.close(reason);
    },
  };
}

function isTraceCall(value: unknown): value is TraceCall {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value['sequence']) &&
    (value['sequence'] as number) > 0 &&
    typeof value['name'] === 'string' &&
    Object.hasOwn(value, 'arguments')
  );
}

function isTraceInitialization(value: unknown): value is TraceInitialization {
  return isRecord(value) && value['kind'] === 'initialize' && typeof value['charterSha256'] === 'string';
}

/** Parse and validate a fixture-server JSONL trace without interpreting model text. */
export function parseTraceJsonl(text: string, expectedCharterSha256: string): ParsedTrace {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { status: 'unscorable', reason: 'missing initialize marker', calls: [] };

  const rows: unknown[] = [];
  try {
    for (const line of lines) rows.push(JSON.parse(line) as unknown);
  } catch {
    return { status: 'unscorable', reason: 'malformed JSONL trace', calls: [] };
  }

  const initial = rows[0];
  if (!isTraceInitialization(initial)) {
    return { status: 'unscorable', reason: 'missing or malformed initialize marker', calls: [] };
  }
  if (initial.charterSha256 !== expectedCharterSha256) {
    return { status: 'unscorable', reason: 'initialize marker charter hash mismatch', calls: [] };
  }

  const calls: TraceCall[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    if (!isTraceCall(row) || row.sequence !== index + 1) {
      return { status: 'unscorable', reason: 'malformed or out-of-order tool trace', calls };
    }
    calls.push({ sequence: row.sequence, name: row.name, arguments: row.arguments });
  }
  return { status: 'scorable', charterSha256: initial.charterSha256, calls };
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function discoveredFirst(calls: TraceCall[]): boolean {
  const first = calls[0];
  return first?.name === 'list_workflows' && isEmptyObject(first.arguments);
}

/** Pure structured-call scorer; response evidence and transcript text never enter it. */
export function scoreTask(task: CharterTask, trace: ParsedTrace): ScoredTask {
  const common = {
    id: task.id,
    kind: task.kind,
    request: task.request,
    ...(task.expectedWorkflow === undefined ? {} : { expectedWorkflow: task.expectedWorkflow }),
    calls: trace.calls,
  };
  if (trace.status === 'unscorable') {
    return { ...common, classification: 'unscorable', reason: trace.reason };
  }
  if (task.kind === 'ambiguous') {
    return { ...common, classification: 'observed' };
  }
  if (!discoveredFirst(trace.calls)) {
    return { ...common, classification: 'failed', passed: false, reason: 'first call was not list_workflows with {}' };
  }

  const starts = trace.calls.filter((call) => call.name === 'start_run');
  if (task.kind === 'no-match') {
    return starts.length === 0
      ? { ...common, classification: 'passed', passed: true }
      : { ...common, classification: 'failed', passed: false, reason: 'no-match task called start_run' };
  }

  const expected = task.expectedWorkflow!;
  const selectedExpected = starts.some(
    (call) => isRecord(call.arguments) && call.arguments['workflow_name'] === expected,
  );
  const selectedOther = starts.some(
    (call) => !isRecord(call.arguments) || call.arguments['workflow_name'] !== expected,
  );
  if (!selectedExpected) {
    return { ...common, classification: 'failed', passed: false, reason: `did not start ${expected}` };
  }
  if (selectedOther) {
    return { ...common, classification: 'failed', passed: false, reason: 'started a conflicting workflow' };
  }
  return { ...common, classification: 'passed', passed: true };
}

export function makeScoreRecord(
  harness: ScoreRecord['harness'],
  charterSha256: string,
  tasks: TaskRecord[],
): ScoreRecord {
  const scored = tasks.filter((task) => task.kind !== 'ambiguous');
  const passed = scored.filter((task) => task.classification === 'passed').length;
  const denominator = scored.length;
  return {
    harness,
    charterSha256,
    passed,
    denominator,
    percentage: denominator === 0 ? 0 : (passed / denominator) * 100,
    tasks,
  };
}

export function makeReport(
  fixture: CharterFixture,
  scores: ScoreRecord[],
  generatedAt = new Date().toISOString(),
): CharterEvalReport {
  return {
    schemaVersion: 1,
    generatedAt,
    nodeVersion: process.version,
    fixture: { version: fixture.version, catalogDigest: catalogDigest(fixture) },
    scores,
  };
}

/** Report-level guard used before an optional baseline replacement. */
export function validateReport(report: CharterEvalReport): string[] {
  const errors: string[] = [];
  for (const score of report.scores) {
    if (!/^[0-9a-f]{64}$/u.test(score.charterSha256)) {
      errors.push(`${score.harness.id}: charter hash is not a full SHA-256`);
    }
    if (score.denominator !== 4) errors.push(`${score.harness.id}: denominator must be four clear tasks`);
    if (score.tasks.length !== 6) errors.push(`${score.harness.id}: expected six task records`);
    if (score.tasks.some((task) => task.classification === 'unscorable')) {
      errors.push(`${score.harness.id}: one or more tasks are unscorable`);
    }
    if (
      (score.harness.id === 'claude-code' || score.harness.id === 'codex') &&
      score.harness.reportedModel === undefined
    ) {
      errors.push(`${score.harness.id}: provider-selected model is missing`);
    }
  }
  return errors;
}
