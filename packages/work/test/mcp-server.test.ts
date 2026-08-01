import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMcpServer,
  pumpStdin,
  textResult,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  INVALID_REQUEST,
  type LineStream,
  type McpServer,
  type ToolRegistration,
} from '../src/mcp/server.ts';

// ---- harness ----------------------------------------------------------------

interface Harness {
  server: McpServer;
  writes: unknown[];
}

function harness(tools: ToolRegistration[] = []): Harness {
  const writes: unknown[] = [];
  const server = createMcpServer({ name: 'test-srv', version: '9.9.9', tools, write: (m) => writes.push(m) });
  return { server, writes };
}

const echoTool: ToolRegistration = {
  name: 'echo',
  description: 'echo the args back',
  inputSchema: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: true },
  handler: (args) => textResult({ echoed: args }),
};

/** JSON-shaped, inferred-any (no `any` keyword) for terse frame/result reads. */
type J = ReturnType<typeof JSON.parse>;
type Frame = { jsonrpc: string; id?: unknown; result?: J; error?: J; method?: string; params?: J };

// ---- handshake --------------------------------------------------------------

test('initialize echoes a recognized protocol version and advertises tools capability', async () => {
  const { server, writes } = harness();
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  const f = writes[0] as Frame;
  assert.equal(f.id, 1);
  assert.equal(f.result.protocolVersion, '2025-06-18');
  assert.deepEqual(f.result.capabilities, { tools: {} });
  assert.deepEqual(f.result.serverInfo, { name: 'test-srv', version: '9.9.9' });
});

test('initialize falls back to the server version for an unknown protocol', async () => {
  const { server, writes } = harness();
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }));
  assert.equal((writes[0] as Frame).result.protocolVersion, '2025-06-18');
});

test('notifications/initialized is a silent no-op', async () => {
  const { server, writes } = harness();
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(writes.length, 0);
});

test('ping answers {}', async () => {
  const { server, writes } = harness();
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
  assert.deepEqual(writes[0], { jsonrpc: '2.0', id: 7, result: {} });
});

// ---- tools/list + tools/call ------------------------------------------------

test('tools/list returns the registered tool defs', async () => {
  const { server, writes } = harness([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const f = writes[0] as Frame;
  assert.equal(f.result.tools.length, 1);
  assert.equal(f.result.tools[0].name, 'echo');
  assert.equal(f.result.tools[0].description, 'echo the args back');
  assert.ok(f.result.tools[0].inputSchema);
});

test('tools/call dispatches to the handler and returns a text content block', async () => {
  const { server, writes } = harness([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 'hi' } } }));
  const f = writes[0] as Frame;
  assert.equal(f.id, 3);
  assert.equal(f.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(f.result.content[0].text), { echoed: { x: 'hi' } });
  assert.equal(f.result.isError, undefined);
});

test('a handler that throws yields an isError text result, not a crash', async () => {
  const boom: ToolRegistration = { name: 'boom', description: '', inputSchema: { type: 'object' }, handler: () => { throw new Error('kaboom'); } };
  const { server, writes } = harness([boom]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } }));
  const f = writes[0] as Frame;
  assert.equal(f.result.isError, true);
  assert.match(f.result.content[0].text, /kaboom/);
});

test('a call with no arguments key hands the handler an empty object', async () => {
  let seen: unknown;
  const t: ToolRegistration = { name: 't', description: '', inputSchema: { type: 'object' }, handler: (a) => { seen = a; return textResult({}); } };
  const { server } = harness([t]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 't' } }));
  assert.deepEqual(seen, {});
});

// ---- errors -----------------------------------------------------------------

test('an unknown tool → METHOD_NOT_FOUND', async () => {
  const { server, writes } = harness([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } }));
  assert.equal((writes[0] as Frame).error.code, METHOD_NOT_FOUND);
});

test('tools/call without a name → INVALID_PARAMS', async () => {
  const { server, writes } = harness([echoTool]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} }));
  assert.equal((writes[0] as Frame).error.code, INVALID_PARAMS);
});

test('an unknown method → METHOD_NOT_FOUND', async () => {
  const { server, writes } = harness();
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'frobnicate' }));
  assert.equal((writes[0] as Frame).error.code, METHOD_NOT_FOUND);
});

test('an unparseable line → a null-id PARSE_ERROR and the server keeps serving', async () => {
  const { server, writes } = harness();
  await server.handleLine('{ this is not json');
  const f = writes[0] as Frame;
  assert.equal(f.id, null);
  assert.equal(f.error.code, PARSE_ERROR);
  // still alive:
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  assert.deepEqual(writes[1], { jsonrpc: '2.0', id: 1, result: {} });
});

test('a request missing "method" → INVALID_REQUEST', async () => {
  const { server, writes } = harness();
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2 }));
  const f = writes[0] as Frame;
  assert.equal(f.id, 2);
  assert.equal(f.error.code, INVALID_REQUEST);
});

test('a blank line is ignored', async () => {
  const { server, writes } = harness();
  await server.handleLine('   ');
  assert.equal(writes.length, 0);
});

test('an unknown method sent as a notification (no id) gets no response', async () => {
  const { server, writes } = harness();
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'frobnicate' }));
  assert.equal(writes.length, 0);
});

// ---- cancellation -----------------------------------------------------------

test('notifications/cancelled aborts an in-flight call — no response frame is sent', async () => {
  const parked: ToolRegistration = {
    name: 'park',
    description: '',
    inputSchema: { type: 'object' },
    handler: (_a, ctx) => new Promise((resolve) => ctx.onCancel(() => resolve(textResult({ done: 'cancelled' })))),
  };
  const { server, writes } = harness([parked]);
  const p = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'park' } }));
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } }));
  await p;
  assert.equal(writes.length, 0); // cancelled call answers nothing
});

test('cancelling an unknown request id is a harmless no-op', async () => {
  const { server, writes } = harness();
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } }));
  assert.equal(writes.length, 0);
});

// ---- progress ---------------------------------------------------------------

test('sendProgress emits a notifications/progress frame only when a progressToken was supplied', async () => {
  const prog: ToolRegistration = {
    name: 'prog',
    description: '',
    inputSchema: { type: 'object' },
    handler: (_a, ctx) => {
      ctx.sendProgress({ progress: 1, total: 2, message: 'halfway' });
      return textResult({ ok: true });
    },
  };
  const { server, writes } = harness([prog]);
  await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prog', _meta: { progressToken: 'tok-1' } } }),
  );
  const progressFrame = writes.find((w) => (w as Frame).method === 'notifications/progress') as Frame | undefined;
  assert.ok(progressFrame, 'a progress frame was emitted');
  assert.equal(progressFrame!.params.progressToken, 'tok-1');
  assert.equal(progressFrame!.params.message, 'halfway');
});

test('sendProgress is a no-op without a progressToken', async () => {
  const prog: ToolRegistration = {
    name: 'prog',
    description: '',
    inputSchema: { type: 'object' },
    handler: (_a, ctx) => {
      ctx.sendProgress({ message: 'nobody listening' });
      return textResult({ ok: true });
    },
  };
  const { server, writes } = harness([prog]);
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prog' } }));
  assert.equal(writes.filter((w) => (w as Frame).method === 'notifications/progress').length, 0);
});

// ---- pumpStdin --------------------------------------------------------------

/** A scriptable LineStream that captures handlers and lets the test push data/EOF. */
function fakeStream(): { stream: LineStream; push: (s: string) => void; end: () => void } {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const stream = {
    on(event: string, handler: (...a: unknown[]) => void) {
      (handlers[event] ??= []).push(handler);
      return stream;
    },
    setEncoding() {},
    resume() {},
  } as unknown as LineStream;
  return {
    stream,
    push: (s) => handlers['data']?.forEach((h) => h(s)),
    end: () => handlers['end']?.forEach((h) => h()),
  };
}

test('pumpStdin splits newline-framed input across torn chunks and closes on EOF', async () => {
  const { server, writes } = harness([echoTool]);
  const { stream, push, end } = fakeStream();
  let eofCalled = false;
  pumpStdin(stream, server, () => { eofCalled = true; });

  // Two frames arriving split across chunks (the second frame is torn mid-string).
  const frame1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const frame2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { x: 'z' } } });
  const torn = frame1 + '\n' + frame2;
  const cut = frame1.length + 1 + Math.floor(frame2.length / 2);
  push(torn.slice(0, cut));
  push(torn.slice(cut) + '\n');
  end();

  // Let the internal promise chain flush.
  await new Promise((r) => setTimeout(r, 10));

  assert.equal((writes[0] as Frame).id, 1);
  assert.equal((writes[1] as Frame).id, 2);
  assert.deepEqual(JSON.parse((writes[1] as Frame).result.content[0].text), { echoed: { x: 'z' } });
  assert.equal(eofCalled, true);
});

test('pumpStdin delivers notifications/cancelled while a tools/call is parked (reviewer regression: cancel-mid-park)', async () => {
  // The park resolves ONLY on cancellation — if the pump serialized frames
  // behind the in-flight call, the cancel would queue forever and this test
  // would time out.
  let sawCancel = false;
  const parked: ToolRegistration = {
    name: 'park',
    description: '',
    inputSchema: { type: 'object' },
    handler: (_a, ctx) =>
      new Promise((resolve) =>
        ctx.onCancel(() => {
          sawCancel = true;
          resolve(textResult({}));
        }),
      ),
  };
  const { server, writes } = harness([parked]);
  const { stream, push } = fakeStream();
  pumpStdin(stream, server);

  push(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'park' } }) + '\n');
  push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n');
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(sawCancel, true, 'the cancel reached the parked call through the pump');
  assert.equal(writes.length, 0, 'a cancelled call answers nothing');
});

test('pumpStdin answers ping while a tools/call is parked (frames are not serialized behind it)', async () => {
  const parked: ToolRegistration = {
    name: 'park',
    description: '',
    inputSchema: { type: 'object' },
    handler: (_a, ctx) => new Promise((resolve) => ctx.onCancel(() => resolve(textResult({})))),
  };
  const { server, writes } = harness([parked]);
  const { stream, push, end } = fakeStream();
  let eofCalled = false;
  pumpStdin(stream, server, () => { eofCalled = true; });

  push(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'park' } }) + '\n');
  push(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(writes[0], { jsonrpc: '2.0', id: 2, result: {} }, 'ping answered while the call is still parked');

  // EOF closes the server, which cancels the parked call so the process's wait
  // on the pump can end — and unlike a CLIENT cancel, the close-cancelled
  // call's reply is still flushed to the pipe (a call received before EOF
  // deserves its answer; reviewer error 1's response-frame race).
  end();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(eofCalled, true);
  assert.equal(writes.length, 2, 'the close-unparked call still answered');
  assert.equal((writes[1] as Frame).id, 1);
});

test('pumpStdin flushes a non-empty trailing partial line at EOF', async () => {
  const { server, writes } = harness();
  const { stream, push, end } = fakeStream();
  pumpStdin(stream, server);
  push(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })); // no trailing newline
  end();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((writes[0] as Frame).id, 5);
});
