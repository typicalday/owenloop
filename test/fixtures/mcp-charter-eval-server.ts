import { appendFileSync, writeFileSync } from 'node:fs';

import { pumpStdin } from '../../src/mcp/server.ts';
import type { LineStream } from '../../src/mcp/server.ts';
import { createFixtureMcpServer, loadCharterFixture, sha256 } from '../helpers/mcp-charter-eval.ts';

function usage(): never {
  throw new Error('usage: node test/fixtures/mcp-charter-eval-server.ts --fixture <path> --trace <path>');
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) usage();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const fixturePath = option('--fixture');
const tracePath = option('--trace');
const fixture = await loadCharterFixture(fixturePath);
let sequence = 0;

// Create rather than append a trace from an old task attempt. Every subsequent
// append is a single JSONL row received or emitted by this local process.
writeFileSync(tracePath, '');
const append = (row: unknown): void => appendFileSync(tracePath, `${JSON.stringify(row)}\n`);

const server = createFixtureMcpServer(fixture, {
  name: 'mcp-charter-eval-fixture',
  version: String(fixture.version),
  record: (name, arguments_) => {
    sequence += 1;
    append({ sequence, name, arguments: arguments_ });
  },
  write: (frame) => {
    // The real core generates initialize.instructions. Record the digest at that
    // actual transport boundary, not by importing the charter source constant.
    if (isRecord(frame) && isRecord(frame['result']) && typeof frame['result']['instructions'] === 'string') {
      append({ kind: 'initialize', charterSha256: sha256(frame['result']['instructions']) });
    }
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  },
  err: (line) => process.stderr.write(`${line}\n`),
});

pumpStdin(process.stdin as unknown as LineStream, server);
