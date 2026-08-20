import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { mainAsync } from '../src/cli.ts';
import type { CliIO } from '../src/cli.ts';
import { kcHuman, makeFakeHub, makeIo, routedFetch } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';
const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18' },
});

function mcpCall(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

async function driveMcp(io: CliIO, lines: string[]): Promise<unknown[]> {
  const stdin = new PassThrough();
  io.stdinStream = stdin;
  const run = mainAsync(['mcp', '--hub', ORIGIN], io);
  for (const line of lines) stdin.write(line + '\n');
  stdin.end();
  await run;
  return [];
}

test('ship x.discovery survives publish, bundle push, and get_workflow unchanged', async () => {
  const t = makeIo();
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'oauth-pasted', accessToken: 'mcpat_human' }));

  const source = join(t.cwd, 'discovery-bundle');
  const workflows = join(source, 'workflows');
  mkdirSync(workflows, { recursive: true });
  const samplePath = join(import.meta.dirname, '..', 'examples', 'workflows', 'ship.yaml');
  const sampleYaml = readFileSync(samplePath, 'utf8');
  copyFileSync(samplePath, join(workflows, 'ship.yaml'));
  writeFileSync(
    join(source, 'bundle.yaml'),
    [
      'formatVersion: 2',
      'package:',
      '  name: discovery-round-trip',
      '  version: 1.0.0',
      'workflows:',
      '  ship: workflows/ship.yaml',
      'default: ship',
      'platforms: []',
      'integrity:',
      '  algorithm: sha256',
      '  files: {}',
      'capabilities: {}',
      'lock: {}',
      '',
    ].join('\n'),
  );

  const archive = join(t.cwd, 'discovery-round-trip.wnlp');
  const publishCode = await mainAsync(['publish', source, '--unsigned', '--output', archive, '--hub', ORIGIN], t.io);
  assert.equal(publishCode, 0, t.err.join('\n'));
  const published = JSON.parse(t.out.at(-1)!) as { digest: string };

  const hub = makeFakeHub();
  hub.routes['POST /api/bundles'] = () => ({ status: 200, json: { ok: true } });
  hub.routes['POST /api/publications/' + published.digest] = () => ({ status: 200, json: { ok: true } });
  const pushedFetch = routedFetch(hub.routes);
  t.io.fetch = pushedFetch.fetch;
  t.out.length = 0;
  t.err.length = 0;

  const pushCode = await mainAsync(['push', '--bundle', archive, '--hub', ORIGIN], t.io);
  assert.equal(pushCode, 0, t.err.join('\n'));
  assert.equal(hub.state.get('ship')!.yaml, sampleYaml, 'push stores the archived workflow bytes verbatim');

  hub.routes['POST /api/stage_enrollment'] = () => ({ status: 404, json: { error: 'not_found' } });
  hub.routes['GET /api/workflows/ship'] = () => ({
    status: 200,
    json: parseYaml(hub.state.get('ship')!.yaml),
  });
  const mcpFetch = routedFetch(hub.routes);
  t.io.fetch = mcpFetch.fetch;
  t.out.length = 0;
  t.err.length = 0;

  await driveMcp(t.io, [INIT, mcpCall(2, 'get_workflow', { name: 'ship' })]);
  const frames = t.out.map((line) => JSON.parse(line) as {
    result?: { content?: Array<{ text: string }> };
  });
  const returned = JSON.parse(frames.at(-1)!.result!.content![0]!.text) as { x?: { discovery?: unknown } };
  const sourceDiscovery = (parseYaml(sampleYaml) as { x?: { discovery?: unknown } }).x?.discovery;

  assert.deepEqual(returned.x?.discovery, sourceDiscovery);
  assert.equal(JSON.stringify(returned.x?.discovery), JSON.stringify(sourceDiscovery));
});
