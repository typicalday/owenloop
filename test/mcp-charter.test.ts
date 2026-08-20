import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createMcpServer } from '../src/mcp/server.ts';

test('mcp charter: initialize returns non-empty instructions under 600 words and names only registered verbs', async () => {
  const frames: Array<{ result?: Record<string, unknown> }> = [];
  const server = createMcpServer({
    name: 'owenloop-cli-mcp',
    version: '0.0.1',
    tools: [],
    write: (frame) => frames.push(frame as { result?: Record<string, unknown> }),
  });

  await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  );

  assert.equal(frames.length, 1);
  const result = frames[0]!.result;
  assert.ok(result !== undefined);
  assert.ok(Object.hasOwn(result, 'instructions'));
  const instructions = result.instructions;
  assert.ok(typeof instructions === 'string');
  assert.notEqual(instructions.trim(), '');
  assert.ok(instructions.trim().split(/\s+/u).length < 600);

  const serveSource = await readFile(new URL('../src/mcp/serve.ts', import.meta.url), 'utf8');
  const registeredNames = new Set([...serveSource.matchAll(/name: '([a-z_]+)'/gu)].map((match) => match[1]!));
  const charterNames = new Set([...instructions.matchAll(/`([a-z_]+)`/gu)].map((match) => match[1]!));

  for (const name of charterNames) {
    assert.ok(registeredNames.has(name), `charter names registered verb ${name}`);
  }
});
