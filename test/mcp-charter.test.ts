import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { mainAsync } from '../src/cli.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import type { ToolRegistration } from '../src/mcp/server.ts';
import {
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
import { finalResponseEvidence, runTask } from './mcp-charter-eval.ts';
import { makeIo } from './hubkit.ts';
import type { CliIO } from '../src/cli.ts';
import type { AgentEvent, HarnessAdapter, HarnessSessionRef, StartArgs } from '../packages/work/src/harness/contract.ts';

type Frame = { result?: Record<string, unknown> };

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
});

test('mcp charter: hashes exact served instruction bytes with full SHA-256', async () => {
  const instructions = await servedCharterInstructions();
  const hash = sha256(instructions);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(hash, sha256(`${instructions} `));
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
  for (const task of fixture.tasks) {
    if (task.expectedWorkflow !== undefined) assert.ok(names.has(task.expectedWorkflow));
  }
});

test('mcp charter: local stub advertises and records fixed list/get/start behavior', async () => {
  const fixture = await loadCharterFixture();
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const frames: Frame[] = [];
  const server = createMcpServer({
    name: 'fixture',
    version: '1',
    tools: fixtureToolRegistrations(fixture, (name, arguments_) => calls.push({ name, arguments: arguments_ })),
    write: (frame) => frames.push(frame as Frame),
  });

  await server.handleLine(INITIALIZE);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  await server.handleLine(toolsCall(3, 'list_workflows'));
  await server.handleLine(toolsCall(4, 'get_workflow', { name: 'code-delivery' }));
  await server.handleLine(toolsCall(5, 'start_run', { workflow_name: 'code-delivery', priority: 'high' }));
  await server.handleLine(toolsCall(6, 'get_workflow', { name: 'not-real' }));

  const listedTools = frames[1]?.result?.['tools'];
  assert.ok(Array.isArray(listedTools));
  assert.ok(listedTools.some((tool) => typeof tool === 'object' && tool !== null && (tool as { name?: string }).name === 'start_run'));
  assert.deepEqual(JSON.parse((frames[2]?.result?.['content'] as Array<{ text: string }>)[0]!.text), fixture.catalog);
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
  ]);
});

test('mcp charter: stub is local with an ambient hub and records exact wire arguments', async () => {
  const fixture = await loadCharterFixture();
  const savedHub = process.env['OWENLOOP_HUB'];
  const savedFetch = globalThis.fetch;
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const frames: Frame[] = [];
  process.env['OWENLOOP_HUB'] = 'https://api.owenloop.com';
  globalThis.fetch = async (): Promise<Response> => {
    throw new Error('fixture must never fetch');
  };
  try {
    const server = createMcpServer({
      name: 'fixture',
      version: '1',
      tools: fixtureToolRegistrations(fixture, (name, arguments_) => calls.push({ name, arguments: arguments_ })),
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
      makeScoreRecord({ id: 'codex', configuredModel: 'fixture' }, hash, records),
    ],
    '2026-08-20T00:00:00.000Z',
  );
  assert.equal(report.scores.length, 2);
  assert.ok(report.scores.every((score) => score.charterSha256 === hash));
  assert.ok(report.scores.every((score) => score.denominator === 4 && score.passed === 4 && score.tasks.length === 6));
  assert.deepEqual(validateReport(report), []);
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
