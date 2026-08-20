import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { mainAsync } from '../src/cli.ts';
import { INVALID_PARAMS } from '../src/mcp/server.ts';
import type { ToolRegistration } from '../src/mcp/server.ts';
import { buildClaudeOptions } from '../packages/work/src/harness/claude.ts';
import { buildThreadStartParams } from '../packages/work/src/harness/codex.ts';
import {
  FIXTURE_NO_OP_TOOL_NAMES,
  createFixtureMcpServer,
  fixtureToolRegistrations,
  loadCharterFixture,
  makeReport,
  makeScoreRecord,
  parseTraceJsonl,
  scoreTask,
  servedCharterInstructions,
  sha256,
  validateReport,
} from './helpers/mcp-charter-eval.ts';
import type { CharterTask, ParsedTrace, TaskRecord, TraceCall } from './helpers/mcp-charter-eval.ts';
import {
  CLAUDE_EVAL_PERMISSIONS,
  CODEX_EVAL_PERMISSIONS,
  claudeFixtureMountFailure,
  finalResponseEvidence,
  mergeReportedModel,
  reportedMetadata,
  runTask,
} from './mcp-charter-eval.ts';
import { makeIo } from './hubkit.ts';
import type { CliIO } from '../src/cli.ts';
import type { AgentEvent, HarnessAdapter, HarnessSessionRef, StartArgs } from '../packages/work/src/harness/contract.ts';

type Frame = { result?: Record<string, unknown>; error?: { code: number; message: string } };

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18' },
});

function toolsCall(id: number, name: string, arguments_: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } });
}

function initTrace(hash: string, calls: TraceCall[]): ParsedTrace {
  return parseTraceJsonl(
    [{ kind: 'initialize', charterSha256: hash }, ...calls].map((row) => JSON.stringify(row)).join('\n'),
    hash,
  );
}

function taskRecord(task: CharterTask, trace: ParsedTrace): TaskRecord {
  return { ...scoreTask(task, trace), responseEvidence: [] };
}

function tracePath(args: StartArgs): string {
  const traceIndex = args.owenloopMcp?.args.indexOf('--trace') ?? -1;
  assert.ok(traceIndex >= 0, 'runner must give the local fixture a trace path');
  const path = args.owenloopMcp?.args[traceIndex + 1];
  if (typeof path !== 'string') throw new Error('runner supplied no trace path');
  return path;
}

async function writeTrace(args: StartArgs, hash: string, calls: TraceCall[] = []): Promise<void> {
  await writeFile(
    tracePath(args),
    [{ kind: 'initialize', charterSha256: hash }, ...calls].map((row) => JSON.stringify(row)).join('\n'),
  );
}

function harnessAdapter(
  start: HarnessAdapter['start'],
  stop: HarnessAdapter['stop'] = async () => {},
): HarnessAdapter {
  return { id: 'fixture-harness', start, stop } as HarnessAdapter;
}

test('mcp charter: initialize serves the charter and every backticked verb is registered by production MCP', async () => {
  const instructions = await servedCharterInstructions();
  assert.notEqual(instructions.trim(), '');
  assert.ok(instructions.trim().split(/\s+/u).length < 600);

  const fetch = async (): Promise<Response> => {
    throw new Error('production tool discovery must not fetch');
  };
  const t = makeIo({
    fetch,
    env: { OWENLOOP_HUB: 'https://api.owenloop.com', OWENLOOP_MCP_ENROLLMENT: '0' },
  });
  const stdin = new PassThrough();
  (t.io as CliIO).stdinStream = stdin;
  const done = mainAsync(['mcp'], t.io);
  stdin.write(`${INITIALIZE}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  stdin.end();
  assert.equal(await done, 0, t.err.join('\n'));

  const frames = t.out.map((line) => JSON.parse(line) as Frame);
  const served = frames[0]?.result?.['instructions'];
  assert.equal(served, instructions, 'the bytes hashed by the evaluator are the production initialize bytes');
  const tools = frames[1]?.result?.['tools'];
  assert.ok(Array.isArray(tools));
  const registeredNames = new Set(
    tools.filter((tool): tool is { name: string } => typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string')
      .map((tool) => tool.name),
  );
  const charterNames = new Set([...instructions.matchAll(/`([a-z_]+)`/gu)].map((match) => match[1]!));
  for (const name of charterNames) {
    assert.ok(registeredNames.has(name), `charter names registered verb ${name}`);
  }

  const fixture = await loadCharterFixture();
  const fixtureTools = new Map(
    fixtureToolRegistrations(fixture).map((tool) => [tool.name, tool]),
  );
  for (const name of FIXTURE_NO_OP_TOOL_NAMES) {
    const productionTool = tools.find(
      (tool) => typeof tool === 'object' && tool !== null && (tool as { name?: string }).name === name,
    ) as { inputSchema?: unknown } | undefined;
    assert.ok(productionTool, `production MCP registers fixture no-op ${name}`);
    assert.deepEqual(
      fixtureTools.get(name)?.inputSchema,
      productionTool.inputSchema,
      `${name} fixture schema must match the production MCP contract`,
    );
  }
});

test('mcp charter: hashes exact served instruction bytes with full SHA-256', async () => {
  const instructions = await servedCharterInstructions();
  const hash = sha256(instructions);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(hash, sha256(`${instructions} `));
});

test('mcp charter: names the narrow caller-owned ephemeral self-execution exception', async () => {
  const instructions = await servedCharterInstructions();
  assert.match(instructions, /use the ephemeral skill/u);
  assert.match(instructions, /explicitly ephemeral, caller-owned run is the exception/u);
  assert.match(instructions, /caller may execute its served orders and return their real outputs/u);
  assert.match(instructions, /let its crews execute/u, 'ordinary runs remain crew-first');
  assert.match(instructions, /not for a chief of staff to fabricate progress/u, 'ordinary submits remain non-fabricating');
});

test('mcp charter: fixed fixture has two tasks in each category with valid workflow references', async () => {
  const fixture = await loadCharterFixture();
  assert.equal(fixture.catalog.length, 2);
  assert.deepEqual(
    fixture.tasks.reduce<Record<string, number>>((counts, task) => {
      counts[task.kind] = (counts[task.kind] ?? 0) + 1;
      return counts;
    }, {}),
    { match: 2, 'no-match': 2, ambiguous: 2 },
  );
  assert.equal(new Set(fixture.tasks.map((task) => task.id)).size, 6);
  const names = new Set(fixture.catalog.map((workflow) => workflow.name));
  for (const workflow of fixture.catalog) {
    assert.deepEqual(
      workflow.inputSchemas.map((entry) => entry.name),
      workflow.inputs,
      `${workflow.name} must expose ordered production-shaped input schema entries`,
    );
    assert.equal(Object.hasOwn(workflow, 'x.discovery'), false, 'discovery metadata must not be a literal dotted key');
    assert.equal(typeof workflow.x.discovery['description'], 'string');
  }
  for (const task of fixture.tasks) {
    if (task.expectedWorkflow !== undefined) assert.ok(names.has(task.expectedWorkflow));
  }
});

test('mcp charter: the Claude treatment isolates ambient settings, skills, and MCP servers', () => {
  const options = buildClaudeOptions(
    {
      cwd: '/tmp/mcp-charter-fixture',
      owenloopMcp: { command: process.execPath, args: ['test/fixtures/mcp-charter-eval-server.ts'] },
      permissions: {
        ...CLAUDE_EVAL_PERMISSIONS,
        extensions: {
          skills: 'all',
          mcpServers: { ambient: { command: 'would-reach-production', args: [] } },
        },
      },
    },
    { env: {}, abortController: new AbortController(), onEvent: () => {} },
  );

  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(Object.keys(options.mcpServers as Record<string, unknown>), ['owenloop']);
  assert.deepEqual(options.tools, [], 'the MCP-only evaluation must expose no built-in file readers');
});

test('mcp charter: local stub advertises and records fixed list/get/start behavior and production-shaped no-ops', async () => {
  const fixture = await loadCharterFixture();
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const frames: Frame[] = [];
  const server = createFixtureMcpServer(fixture, {
    name: 'fixture',
    version: '1',
    record: (name, arguments_) => calls.push({ name, arguments: arguments_ }),
    write: (frame) => frames.push(frame as Frame),
  });

  await server.handleLine(INITIALIZE);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  await server.handleLine(toolsCall(3, 'list_workflows'));
  await server.handleLine(toolsCall(4, 'get_workflow', { name: 'code-delivery' }));
  await server.handleLine(toolsCall(5, 'start_run', { workflow_name: 'code-delivery', priority: 'high' }));
  await server.handleLine(toolsCall(6, 'get_workflow', { name: 'not-real' }));
  await server.handleLine(toolsCall(7, 'submit', {
    workflow: 'fixture-run',
    run: 'run-1',
    path: 'result',
    value: { text: 'fixture value' },
    done: true,
  }));
  await server.handleLine(toolsCall(8, 'wake', { cursor: 4 }));
  await server.handleLine(toolsCall(9, 'whats_next', {
    workflow: 'fixture-run',
    serve_crews: ['builder'],
    serve_capabilities: ['code'],
  }));
  await server.handleLine(toolsCall(10, 'provide_input', {
    workflow: 'fixture-run',
    name: 'proposal',
    value: { text: 'fixture proposal' },
  }));
  await server.handleLine(toolsCall(11, 'retry_artifact', {
    workflow: 'fixture-run',
    path: 'result',
    text: 'try again',
  }));
  await server.handleLine(toolsCall(12, 'reject_artifact', {
    workflow: 'fixture-run',
    path: 'result',
    reason: 'fixture reason',
  }));

  const listedTools = frames[1]?.result?.['tools'];
  assert.ok(Array.isArray(listedTools));
  assert.ok(listedTools.some((tool) => typeof tool === 'object' && tool !== null && (tool as { name?: string }).name === 'start_run'));
  assert.deepEqual(
    JSON.parse((frames[2]?.result?.['content'] as Array<{ text: string }>)[0]!.text),
    { workflows: fixture.catalog },
  );
  assert.deepEqual(
    JSON.parse((frames[3]?.result?.['content'] as Array<{ text: string }>)[0]!.text),
    fixture.catalog[0],
  );
  assert.deepEqual(
    JSON.parse((frames[4]?.result?.['content'] as Array<{ text: string }>)[0]!.text),
    { recorded: true, workflow_name: 'code-delivery', priority: 'high' },
  );
  assert.equal((frames[5]?.result?.['isError'] as boolean | undefined), true);
  assert.deepEqual(calls, [
    { name: 'list_workflows', arguments: {} },
    { name: 'get_workflow', arguments: { name: 'code-delivery' } },
    { name: 'start_run', arguments: { workflow_name: 'code-delivery', priority: 'high' } },
    { name: 'get_workflow', arguments: { name: 'not-real' } },
    {
      name: 'submit',
      arguments: {
        workflow: 'fixture-run',
        run: 'run-1',
        path: 'result',
        value: { text: 'fixture value' },
        done: true,
      },
    },
    { name: 'wake', arguments: { cursor: 4 } },
    {
      name: 'whats_next',
      arguments: { workflow: 'fixture-run', serve_crews: ['builder'], serve_capabilities: ['code'] },
    },
    {
      name: 'provide_input',
      arguments: { workflow: 'fixture-run', name: 'proposal', value: { text: 'fixture proposal' } },
    },
    { name: 'retry_artifact', arguments: { workflow: 'fixture-run', path: 'result', text: 'try again' } },
    { name: 'reject_artifact', arguments: { workflow: 'fixture-run', path: 'result', reason: 'fixture reason' } },
  ]);
});

test('mcp charter: wire trace retains schema-rejected calls before dispatcher validation', async () => {
  const fixture = await loadCharterFixture();
  const calls: TraceCall[] = [];
  const frames: Frame[] = [];
  let sequence = 0;
  const server = createFixtureMcpServer(fixture, {
    name: 'fixture',
    version: '1',
    record: (name, arguments_) => calls.push({ sequence: ++sequence, name, arguments: arguments_ }),
    write: (frame) => frames.push(frame as Frame),
  });

  await server.handleLine(INITIALIZE);
  await server.handleLine(toolsCall(2, 'list_workflows'));
  await server.handleLine(toolsCall(3, 'start_run', {}));
  await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'start_run', arguments: [] } }),
  );
  await server.handleLine(toolsCall(5, 'list_workflows', { unexpected: true }));

  assert.deepEqual(frames.slice(2).map((frame) => frame.error?.code), [
    INVALID_PARAMS,
    INVALID_PARAMS,
    INVALID_PARAMS,
  ]);
  assert.deepEqual(calls, [
    { sequence: 1, name: 'list_workflows', arguments: {} },
    { sequence: 2, name: 'start_run', arguments: {} },
    { sequence: 3, name: 'start_run', arguments: [] },
    { sequence: 4, name: 'list_workflows', arguments: { unexpected: true } },
  ]);

  const finance = fixture.tasks.find((task) => task.id === 'no-match-finance')!;
  const hash = '9'.repeat(64);
  assert.equal(
    scoreTask(finance, initTrace(hash, calls.slice(0, 2))).classification,
    'failed',
    'a schema-invalid start after discovery must fail a no-match task',
  );
  assert.equal(
    scoreTask(finance, initTrace(hash, [calls[0]!, { ...calls[2]!, sequence: 2 }])).classification,
    'failed',
    'a malformed start after discovery must remain visible and fail',
  );
  assert.equal(
    scoreTask(finance, initTrace(hash, [{ ...calls[3]!, sequence: 1 }])).classification,
    'failed',
    'a schema-rejected discovery call with wrong arguments is not valid discovery',
  );
});

test('mcp charter: stub is local with an ambient hub and records exact wire arguments', async () => {
  const fixture = await loadCharterFixture();
  const savedHub = process.env['OWENLOOP_HUB'];
  const savedFetch = globalThis.fetch;
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const frames: Frame[] = [];
  process.env['OWENLOOP_HUB'] = 'https://api.owenloop.com';
  globalThis.fetch = async (): Promise<Response> => {
    throw new Error('fixture must never fetch');
  };
  try {
    const server = createFixtureMcpServer(fixture, {
      name: 'fixture',
      version: '1',
      record: (name, arguments_) => calls.push({ name, arguments: arguments_ }),
      write: (frame) => frames.push(frame as Frame),
    });
    await server.handleLine(INITIALIZE);
    await server.handleLine(toolsCall(2, 'list_workflows'));
    await server.handleLine(toolsCall(3, 'start_run', { workflow_name: 'library-build', scope: 'eval' }));
    assert.equal(frames.length, 3);
    assert.deepEqual(calls, [
      { name: 'list_workflows', arguments: {} },
      { name: 'start_run', arguments: { workflow_name: 'library-build', scope: 'eval' } },
    ]);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedHub === undefined) delete process.env['OWENLOOP_HUB'];
    else process.env['OWENLOOP_HUB'] = savedHub;
  }
});

test('mcp charter: scorer covers clear-task failures, observations, and unscorable traces', async () => {
  const fixture = await loadCharterFixture();
  const hash = 'a'.repeat(64);
  const delivery = fixture.tasks.find((task) => task.id === 'match-delivery')!;
  const finance = fixture.tasks.find((task) => task.id === 'no-match-finance')!;
  const ambiguous = fixture.tasks.find((task) => task.id === 'ambiguous-launch')!;
  const list: TraceCall = { sequence: 1, name: 'list_workflows', arguments: {} };
  const deliveryStart: TraceCall = { sequence: 2, name: 'start_run', arguments: { workflow_name: 'code-delivery' } };

  assert.equal(scoreTask(delivery, initTrace(hash, [list, deliveryStart])).classification, 'passed');
  assert.equal(
    scoreTask(
      delivery,
      initTrace(hash, [
        { sequence: 1, name: 'start_run', arguments: { workflow_name: 'code-delivery' } },
        { sequence: 2, name: 'list_workflows', arguments: {} },
      ]),
    ).classification,
    'failed',
    'start-before-list fails discovery order',
  );
  assert.equal(scoreTask(delivery, initTrace(hash, [])).classification, 'failed', 'initialized no-call clear task fails');
  assert.equal(
    scoreTask(delivery, initTrace(hash, [list, { sequence: 2, name: 'start_run', arguments: { workflow_name: 'library-build' } }])).classification,
    'failed',
    'wrong workflow fails',
  );
  assert.equal(
    scoreTask(
      delivery,
      initTrace(hash, [
        list,
        deliveryStart,
        { sequence: 3, name: 'start_run', arguments: { workflow_name: 'library-build' } },
      ]),
    ).classification,
    'failed',
    'conflicting workflow fails',
  );
  assert.equal(scoreTask(finance, initTrace(hash, [list])).classification, 'passed');
  assert.equal(
    scoreTask(finance, initTrace(hash, [list, deliveryStart])).classification,
    'failed',
    'no-match start fails',
  );
  assert.equal(scoreTask(ambiguous, initTrace(hash, [list])).classification, 'observed');
  assert.equal(scoreTask(delivery, parseTraceJsonl('', hash)).classification, 'unscorable');
  assert.equal(
    scoreTask(delivery, parseTraceJsonl(JSON.stringify({ kind: 'initialize', charterSha256: 'b'.repeat(64) }), hash)).classification,
    'unscorable',
  );
});

test('mcp charter: report aggregates two harnesses under one hash and excludes observations', async () => {
  const fixture = await loadCharterFixture();
  const hash = 'c'.repeat(64);
  const traces = new Map<string, ParsedTrace>();
  for (const task of fixture.tasks) {
    const calls: TraceCall[] =
      task.kind === 'match'
        ? [
            { sequence: 1, name: 'list_workflows', arguments: {} },
            { sequence: 2, name: 'start_run', arguments: { workflow_name: task.expectedWorkflow } },
          ]
        : [{ sequence: 1, name: 'list_workflows', arguments: {} }];
    traces.set(task.id, initTrace(hash, calls));
  }
  const records = fixture.tasks.map((task) => taskRecord(task, traces.get(task.id)!));
  const report = makeReport(
    fixture,
    [
      makeScoreRecord({ id: 'claude-code', reportedModel: 'fixture' }, hash, records),
      makeScoreRecord({ id: 'codex', configuredModel: 'fixture', reportedModel: 'fixture' }, hash, records),
    ],
    '2026-08-20T00:00:00.000Z',
  );
  assert.equal(report.scores.length, 2);
  assert.ok(report.scores.every((score) => score.charterSha256 === hash));
  assert.ok(report.scores.every((score) => score.denominator === 4 && score.passed === 4 && score.tasks.length === 6));
  assert.deepEqual(validateReport(report), []);

  const unattributed = structuredClone(report);
  const codex = unattributed.scores.find((score) => score.harness.id === 'codex');
  assert.ok(codex !== undefined);
  delete codex.harness.reportedModel;
  assert.ok(
    validateReport(unattributed).includes('codex: provider-selected model is missing'),
    'a configured override alone must not masquerade as the provider-selected model',
  );
});

test('mcp charter runner makes adapter exits unscorable and retains only final response evidence', async () => {
  const hash = 'd'.repeat(64);
  const ref: HarnessSessionRef = { harness: 'fixture-harness', token: 'provider-failure' };
  let sessionCwd: string | undefined;
  let evidencePath: string | undefined;
  const adapter = harnessAdapter(async (args, onEvent) => {
    sessionCwd = args.cwd;
    evidencePath = tracePath(args);
    onEvent({ kind: 'started', ref });
    await writeTrace(args, hash, [{ sequence: 1, name: 'list_workflows', arguments: {} }]);
    onEvent({ kind: 'progress', text: 'thinking: private local telemetry' });
    onEvent({ kind: 'progress', text: 'stderr: a tool result' });
    onEvent({ kind: 'assistant_response', text: 'I cannot find a matching workflow.' });
    onEvent({ kind: 'exited', exitCode: null, error: 'model_not_found' });
    onEvent({ kind: 'turn_ended' });
    return ref;
  });

  const run = await runTask(
    { id: 'fixture-harness', adapter, permissions: { extensions: {} } },
    { request: 'please help' },
    'fixture.json',
    hash,
    { taskTimeoutMs: 100 },
  );

  assert.equal(run.trace.status, 'unscorable');
  assert.match(run.trace.reason, /adapter reported exit: model_not_found/);
  assert.deepEqual(run.trace.calls, [{ sequence: 1, name: 'list_workflows', arguments: {} }]);
  assert.deepEqual(run.responseEvidence, ['I cannot find a matching workflow.']);
  assert.ok(sessionCwd !== undefined && evidencePath !== undefined);
  assert.notEqual(dirname(evidencePath), sessionCwd, 'trace must be outside the evaluated session cwd');
  assert.equal(evidencePath.startsWith(`${sessionCwd}${sep}`), false, 'trace cannot be a file in the evaluated workspace');
});

test('mcp charter runner rejects unhealthy Claude fixture mounts and accepts pending or connected', async () => {
  const hash = '7'.repeat(64);
  for (const [status, healthy] of [
    ['pending', true],
    ['connected', true],
    ['failed', false],
    ['needs-auth', false],
    ['disabled', false],
  ] as const) {
    const ref: HarnessSessionRef = { harness: 'claude-code', token: `mount-${status}` };
    const init =
      `session ${ref.token}: cliVersion=2.1.236 model=claude-opus-5 ` +
      `apiKeySource=none permissionMode=bypassPermissions mcp=[owenloop=${status}]`;
    const adapter = harnessAdapter(async (args, onEvent) => {
      onEvent({ kind: 'started', ref });
      await writeTrace(args, hash);
      onEvent({ kind: 'progress', text: init });
      onEvent({ kind: 'turn_ended' });
      return ref;
    });

    const run = await runTask(
      { id: 'claude-code', adapter, permissions: CLAUDE_EVAL_PERMISSIONS },
      { request: 'please help' },
      'fixture.json',
      hash,
      { taskTimeoutMs: 100 },
    );
    assert.equal(run.trace.status, healthy ? 'scorable' : 'unscorable', status);
    assert.equal(
      claudeFixtureMountFailure([{ kind: 'progress', text: init }]),
      healthy ? undefined : `fixture MCP mount reported unhealthy Claude status: ${status}`,
    );
  }

  assert.equal(
    claudeFixtureMountFailure([{ kind: 'progress', text: 'session abc: model=claude-opus-5 mcp=[]' }]),
    'Claude init metadata did not report fixture MCP mount status',
  );
});

test('mcp charter runner isolates Codex config without severing file authentication', async (t) => {
  const hash = 'f'.repeat(64);
  const previousCodexHome = process.env['CODEX_HOME'];
  const operatorHome = await mkdtemp(join(tmpdir(), 'owenloop-mcp-charter-operator-codex-home-'));
  const fakeAuth = '{"auth_mode":"chatgpt","tokens":{"access_token":"test-only"}}\n';
  await writeFile(
    join(operatorHome, 'config.toml'),
    '[mcp_servers.ambient]\ncommand = "would-reach-production"\n',
  );
  await writeFile(join(operatorHome, 'auth.json'), fakeAuth, { mode: 0o600 });
  process.env['CODEX_HOME'] = operatorHome;
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previousCodexHome;
    await rm(operatorHome, { recursive: true, force: true });
  });

  const ref: HarnessSessionRef = { harness: 'codex', token: 'isolated-config' };
  let observedHome: string | undefined;
  let observedConfig: string | undefined;
  let observedAuth: string | undefined;
  const adapter = harnessAdapter(async (args, onEvent) => {
    observedHome = process.env['CODEX_HOME'];
    assert.notEqual(observedHome, operatorHome, 'the task must not inherit the operator config root');
    assert.ok(observedHome !== undefined);
    observedConfig = await readFile(join(observedHome, 'config.toml'), 'utf8');
    observedAuth = await readFile(join(observedHome, 'auth.json'), 'utf8');

    const params = buildThreadStartParams(args);
    const config = params['config'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(config['mcp_servers'] as Record<string, unknown>), ['owenloop']);
    assert.deepEqual(config['agents'], { enabled: false });
    assert.deepEqual(config['apps'], { _default: { enabled: false } });
    assert.deepEqual(config['tools'], { view_image: false, web_search: false });
    assert.deepEqual(config['shell_environment_policy'], { inherit: 'none', ignore_default_excludes: false });
    assert.equal((config['features'] as Record<string, unknown>)['shell_tool'], false);
    assert.equal((config['features'] as Record<string, unknown>)['unified_exec'], false);
    assert.equal(config['web_search'], 'disabled');

    onEvent({ kind: 'started', ref });
    await writeTrace(args, hash);
    onEvent({ kind: 'turn_ended' });
    return ref;
  });

  await runTask(
    { id: 'codex', adapter, permissions: CODEX_EVAL_PERMISSIONS },
    { request: 'please help' },
    'fixture.json',
    hash,
    { taskTimeoutMs: 100 },
  );

  assert.equal(observedConfig, 'cli_auth_credentials_store = "file"\n');
  assert.equal(observedAuth, fakeAuth, 'file-backed auth must reach the app-server in its private root');
  assert.equal(process.env['CODEX_HOME'], operatorHome, 'the operator config root must be restored after the task');
  assert.equal(await readFile(join(operatorHome, 'auth.json'), 'utf8'), fakeAuth, 'the source login remains intact');
  assert.ok(observedHome !== undefined);
  await assert.rejects(readFile(join(observedHome, 'auth.json'), 'utf8'), /ENOENT/);
});

test('mcp charter runner stops a started session at its deadline and preserves its trace as unscorable', async () => {
  const hash = 'e'.repeat(64);
  const ref: HarnessSessionRef = { harness: 'fixture-harness', token: 'deadline' };
  let stopCalls = 0;
  const adapter = harnessAdapter(
    async (args, onEvent) => {
      onEvent({ kind: 'started', ref });
      await writeTrace(args, hash, [{ sequence: 1, name: 'list_workflows', arguments: {} }]);
      return await new Promise<HarnessSessionRef>(() => {});
    },
    async () => {
      stopCalls += 1;
    },
  );

  const run = await runTask(
    { id: 'fixture-harness', adapter, permissions: { extensions: {} } },
    { request: 'please help' },
    'fixture.json',
    hash,
    { taskTimeoutMs: 20 },
  );

  assert.equal(run.trace.status, 'unscorable');
  assert.match(run.trace.reason, /task deadline exceeded after 20ms/);
  assert.deepEqual(run.trace.calls, [{ sequence: 1, name: 'list_workflows', arguments: {} }]);
  assert.equal(stopCalls, 1, 'the synchronous started reference must be stopped after timeout');
});

test('mcp charter response evidence excludes all generic progress telemetry', () => {
  const events: AgentEvent[] = [
    { kind: 'progress', text: 'thinking: private' },
    { kind: 'progress', text: 'tool_result: secret' },
    { kind: 'assistant_response', text: 'final answer' },
    { kind: 'progress', text: 'stderr: local details' },
  ];
  assert.deepEqual(finalResponseEvidence(events), ['final answer']);
});

test('mcp charter records model metadata from the real adapter init-line shape', () => {
  assert.deepEqual(
    reportedMetadata([
      {
        kind: 'progress',
        text: 'session abc: cliVersion=2.1.220 model=claude-opus-5 apiKeySource=none permissionMode=bypassPermissions',
      },
    ]),
    { reportedModel: 'claude-opus-5', version: '2.1.220' },
  );
  const codexStarted: AgentEvent = {
    kind: 'started',
    ref: { harness: 'codex', token: 'thread-id' },
    model: 'gpt-5.6-terra',
  };
  assert.deepEqual(
    reportedMetadata([
      codexStarted,
      {
        kind: 'progress',
        text: 'app-server ready: userAgent=owenloop-recorder/0.146.0 (Mac OS 26.2.0; arm64)',
      },
    ]),
    { reportedModel: 'gpt-5.6-terra', version: '0.146.0' },
  );
  assert.equal(mergeReportedModel('codex', undefined, 'gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(mergeReportedModel('codex', 'gpt-5.6-terra', 'gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.throws(
    () => mergeReportedModel('codex', 'gpt-5.6-terra', 'gpt-5.6-sol'),
    /codex reported model drift across tasks: gpt-5\.6-terra -> gpt-5\.6-sol/u,
  );
});
