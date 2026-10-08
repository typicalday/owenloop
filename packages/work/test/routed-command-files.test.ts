import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { hasConsumedFilePointers, materializeRoutedCommandFiles } from '../src/hub/routed-command-files.ts';
import { createDefaultRunner } from '../src/exec/runner.ts';
import type { RoutingChildClient } from '../src/hub/routing-child-client.ts';
import type { FileArtifactPointer, GetOrderResponse, OrderPacket } from '../src/hub/types.ts';

const bytes = Buffer.from('the exact consumed file');
const pointer: FileArtifactPointer = {
  __file: 'orgs/o/artifacts/wf/files/routed/run/file',
  hash: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length, contentType: 'application/octet-stream',
};
const holder = { kind: 'exec' as const, id: 'host:1234' };

test('agent pointer detector distinguishes exact file values from ordinary JSON', () => {
  assert.equal(hasConsumedFilePointers({ ...order(), worker: 'agent' }), true);
  assert.equal(hasConsumedFilePointers({ ...order({ 'seed.value': { text: 'ordinary JSON' } }),
    worker: 'agent' }), false);
  assert.throws(() => hasConsumedFilePointers({ ...order({ 'seed.value': { __file: pointer.__file } }),
    worker: 'agent' }), /routed consumed files refused/);
});

function order(consumes: Record<string, unknown> = { 'seed.value': { nested: [pointer] } }): OrderPacket {
  return { workflow: 'wf', run: 'run', step: 'command', key: 'k', defDigest: 'digest',
    worker: 'command', inputs: ['seed.value', 'optional'], outputs: ['out'], consumes,
    owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] };
}

function client(packet: OrderPacket, options: { claimed?: boolean; stream?: (p: FileArtifactPointer) =>
  ReturnType<RoutingChildClient['getFileArtifactStream']> } = {}) {
  const seen: Array<{ path: string; key: string }> = [];
  const child: Pick<RoutingChildClient, 'getOrder' | 'getFileArtifactStream'> = {
    getOrder: async () => ({ text: '', workflow: 'wf', run: 'run',
      lease: { claimed: options.claimed ?? true }, order: structuredClone(packet) } satisfies GetOrderResponse),
    getFileArtifactStream: async req => {
      seen.push({ path: req.path, key: req.pointer.__file });
      if (options.stream) return options.stream(req.pointer);
      return { size: req.pointer.size, contentType: req.pointer.contentType,
		chunks: Readable.from([bytes]), verified: Promise.resolve() };
    },
  };
  return { child, seen };
}

async function withBase(body: (base: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'ol-command-files-'));
  chmodSync(base, 0o700);
  try { await body(base); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

test('current nested pointer is fully staged before a command receives its path map', async () => {
  await withBase(async base => {
    const submitted = order();
    const original = JSON.stringify(submitted.consumes);
    const { child, seen } = client(submitted);
    const result = await materializeRoutedCommandFiles({ order: submitted, holder, child, privateBase: base });
    try {
      const map = JSON.parse(result.envValue) as Array<{ artifactPath: string; pointerKey: string; file: string }>;
      assert.equal(map.length, 1);
      assert.equal(map[0]?.artifactPath, 'seed.value');
      assert.equal(map[0]?.pointerKey, pointer.__file);
      assert.equal(readFileSync(map[0]!.file).toString(), bytes.toString());
      assert.equal(statSync(map[0]!.file).mode & 0o777, 0o400);
      assert.deepEqual(seen, [{ path: 'seed.value', key: pointer.__file }]);
      assert.equal(JSON.stringify(submitted.consumes), original, 'original OWENLOOP_CONSUMES stays intact');
      await result.cleanup();
      assert.equal(existsSync(map[0]!.file), false);
    } finally { await result.cleanup(); }
  });
});

test('a routed command with no present file pointer keeps an empty side map', async () => {
  await withBase(async base => {
    const submitted = order({ 'seed.value': { text: 'ordinary JSON' } });
    const { child, seen } = client(submitted);
    const result = await materializeRoutedCommandFiles({ order: submitted, holder, child, privateBase: base });
    assert.equal(result.envValue, '[]');
    assert.deepEqual(seen, []);
    assert.deepEqual(readdirSync(base), []);
    await result.cleanup();
  });
});

test('an actual shell child reads a completed cache path from the env map', async () => {
  await withBase(async base => {
    const submitted = order();
    const { child } = client(submitted);
    const prepared = await materializeRoutedCommandFiles({ order: submitted, holder, child, privateBase: base });
    try {
      const runner = createDefaultRunner();
      const command = `node -e 'const fs = require("node:fs"); `
		+ `const rows = JSON.parse(process.env.OWENLOOP_CONSUMED_FILE_PATHS_JSON); `
		+ `process.stdout.write(fs.readFileSync(rows[0].file, "utf8"))'`;
      const result = await runner.start(command, { cwd: base,
		env: { ...process.env, OWENLOOP_CONSUMED_FILE_PATHS_JSON: prepared.envValue } }).done;
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdoutBytes, bytes.length);
      assert.equal(result.outputTail, bytes.toString());
    } finally { await prepared.cleanup(); }
  });
});

test('stale or released current order refuses before download and leaves no cache', async () => {
  await withBase(async base => {
    const submitted = order();
    const changed = order({ 'seed.value': { nested: [{ ...pointer, hash: 'a'.repeat(64) }] } });
    for (const [current, claimed] of [[changed, true], [submitted, false]] as const) {
      const { child, seen } = client(current, { claimed });
      await assert.rejects(materializeRoutedCommandFiles({ order: submitted, holder, child, privateBase: base }),
		/routed consumed files refused/);
      assert.deepEqual(seen, []);
      assert.deepEqual(readdirSync(base), []);
    }
  });
});

test('a later corrupt stream removes earlier complete files before refusing shell start', async () => {
  await withBase(async base => {
    const second = { ...pointer, __file: `${pointer.__file}-second` };
    const submitted = order({ 'seed.value': [pointer, second] });
    let count = 0;
    const { child, seen } = client(submitted, { stream: async p => {
      count++;
      return { size: p.size, contentType: p.contentType, chunks: Readable.from([bytes]),
		verified: count === 1 ? Promise.resolve() : Promise.reject(new Error('digest mismatch')) };
    } });
    await assert.rejects(materializeRoutedCommandFiles({ order: submitted, holder, child, privateBase: base }),
      /routed consumed files refused/);
    assert.equal(seen.length, 2);
    assert.deepEqual(readdirSync(base), []);
  });
});

test('malformed, oversized or too many pointers refuse without contacting byte stream', async () => {
  await withBase(async base => {
    const invalid = [
      order({ 'seed.value': { ...pointer, size: 500_000_001 } }),
      order({ 'seed.value': { __file: pointer.__file, size: bytes.length } }),
      order({ 'seed.value': Array.from({ length: 17 }, (_, i) => ({ ...pointer,
		__file: `${pointer.__file}-${i}` })) }),
    ];
    for (const submitted of invalid) {
      const { child, seen } = client(submitted);
      await assert.rejects(materializeRoutedCommandFiles({ order: submitted, holder, child, privateBase: base }),
		/routed consumed files refused/);
      assert.deepEqual(seen, []);
      assert.deepEqual(readdirSync(base), []);
    }
  });
});

test('scoped download refusal or cancellation leaves no publishable command path', async () => {
  await withBase(async base => {
    const submitted = order();
    const { child } = client(submitted, { stream: async () => { throw new Error('scoped 403'); } });
    await assert.rejects(materializeRoutedCommandFiles({ order: submitted, holder, child, privateBase: base }),
      /routed consumed files refused/);
    assert.deepEqual(readdirSync(base), []);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(materializeRoutedCommandFiles({ order: submitted, holder,
      child, privateBase: base, signal: stopped.signal }), /routed consumed files refused/);
    assert.deepEqual(readdirSync(base), []);
  });
});
