/**
 * Transport-core acceptance for `src/mcp/server.ts` — the hand-rolled
 * newline-delimited JSON-RPC 2.0 MCP core (a near-verbatim copy of owenwork's;
 * see that file's header). These tests re-prove the copied behavior against THIS
 * copy so drift is caught here rather than assumed: the handshake, tool
 * dispatch, the error envelopes, and the "a notification is never answered"
 * contract. They drive `createMcpServer` directly with an in-memory `write`
 * sink — no child process, no stdio, no hub — so they are pure and fast.
 *
 * The owenloop-specific surface (origin resolution, the authed hub client, the
 * 18/19 tools, the secret discipline) is covered separately in `mcp.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer, textResult, METHOD_NOT_FOUND, PARSE_ERROR, INVALID_PARAMS } from '../src/mcp/server.ts';
import type { ToolRegistration } from '../src/mcp/server.ts';

interface Frame {
  jsonrpc: string;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
}

/** A server wired to an array-backed `write` sink, plus the frames it emitted. */
function makeServer(tools: ToolRegistration[]): { server: ReturnType<typeof createMcpServer>; frames: Frame[]; errs: string[] } {
  const frames: Frame[] = [];
  const errs: string[] = [];
  const server = createMcpServer({
    name: 'owenloop-cli-mcp',
    version: '0.0.1',
    tools,
    write: (msg) => frames.push(msg as Frame),
    err: (line) => errs.push(line),
  });
  return { server, frames, errs };
}

const echoTool: ToolRegistration = {
  name: 'echo',
  description: 'echo its arguments back',
  inputSchema: { type: 'object', properties: { v: { type: 'string' } } },
  handler: (args) => textResult({ echoed: args['v'] }),
};

test('mcpcore: initialize returns capabilities, serverInfo, and echoes a recognized protocolVersion', async () => {
  const { server, frames } = makeServer([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));

  assert.equal(frames.length, 1);
  const r = frames[0]!.result as { protocolVersion: string; capabilities: unknown; serverInfo: { name: string; version: string } };
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.deepEqual(r.serverInfo, { name: 'owenloop-cli-mcp', version: '0.0.1' });
});

test('mcpcore: initialize with an unknown protocolVersion answers with OUR version', async () => {
  const { server, frames } = makeServer([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }));
  assert.equal((frames[0]!.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
});

test('mcpcore: tools/list returns every registered tool with name/description/inputSchema', async () => {
  const { server, frames } = makeServer([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const tools = (frames[0]!.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'echo');
  assert.equal(tools[0]!.description, 'echo its arguments back');
  assert.deepEqual(tools[0]!.inputSchema, { type: 'object', properties: { v: { type: 'string' } } });
});

test('mcpcore: tools/call dispatches to the handler; an unknown tool → METHOD_NOT_FOUND', async () => {
  const { server, frames } = makeServer([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { v: 'hi' } } }));
  const result = frames[0]!.result as { content: Array<{ type: string; text: string }> };
  assert.deepEqual(JSON.parse(result.content[0]!.text), { echoed: 'hi' });

  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }));
  assert.equal(frames[1]!.error!.code, METHOD_NOT_FOUND);
});

test('mcpcore: a handler that throws → an isError result, not a crash, and the server keeps serving', async () => {
  const boom: ToolRegistration = {
    name: 'boom',
    description: 'always throws',
    inputSchema: { type: 'object' },
    handler: () => {
      throw new Error('kaboom');
    },
  };
  const { server, frames, errs } = makeServer([boom, echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom', arguments: {} } }));
  const result = frames[0]!.result as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /kaboom/);
  assert.ok(errs.some((l) => /boom/.test(l)));

  // Still serving after the throw.
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }));
  assert.deepEqual(frames[1]!.result, {});
});

test('mcpcore: a malformed JSON line → a null-id PARSE_ERROR, and the server keeps serving', async () => {
  const { server, frames } = makeServer([echoTool]);
  await server.handleLine('this is not json {');
  assert.equal(frames[0]!.id, null);
  assert.equal(frames[0]!.error!.code, PARSE_ERROR);

  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
  assert.deepEqual(frames[1]!.result, {});
});

test('mcpcore: tools/call without a string name → INVALID_PARAMS', async () => {
  const { server, frames } = makeServer([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} }));
  assert.equal(frames[0]!.error!.code, INVALID_PARAMS);
});

test('mcpcore: a notification (no id) is NEVER answered — initialized and a call-shaped notification both stay silent', async () => {
  const { server, frames } = makeServer([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: { v: 'x' } } }));
  assert.equal(frames.length, 0);
});
