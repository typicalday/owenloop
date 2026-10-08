import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createRoutedFileCache } from '../src/hub/routed-file-cache.ts';
import { createHoldMcp } from '../src/hold/mcp.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { FileArtifactPointer, GetOrderResponse } from '../src/hub/types.ts';
import type { ToolCallContext } from '../src/mcp/server.ts';

const bytes = Buffer.from('verified consumed bytes');
const pointer: FileArtifactPointer = { __file: 'orgs/org/artifacts/wf/files/hash',
  hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  contentType: 'application/octet-stream' };
const req = { workflow: 'wf', run: 'run', path: 'input', pointer };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('cache publishes no path until stream EOF and verified resolve, then cleans up on close', async () => {
  const base = mkdtempSync(join(tmpdir(), 'routed-cache-test-'));
  const proof = deferred<void>();
  const cache = createRoutedFileCache(async () => ({ size: bytes.length,
    contentType: pointer.contentType, chunks: Readable.from([bytes]), verified: proof.promise }), base);
  try {
    const pending = cache.materialize(req);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(readdirSync(join(cache.root, 'verified')), []);
    proof.resolve();
    const result = await pending;
    assert.equal(readFileSync(result.file).toString(), bytes.toString());
    assert.equal(result.size, bytes.length);
    await cache.close();
    assert.equal(existsSync(cache.root), false);
  } finally { await cache.close(); rmSync(base, { recursive: true, force: true }); }
});

test('cache refuses corrupt, short and long streams without a usable file', async () => {
  const base = mkdtempSync(join(tmpdir(), 'routed-cache-test-'));
  for (const actual of [Buffer.from('corrupt'), bytes.subarray(1), Buffer.concat([bytes, bytes])]) {
    const cache = createRoutedFileCache(async () => ({ size: bytes.length,
      contentType: pointer.contentType, chunks: Readable.from([actual]),
      verified: Promise.reject(new Error('digest refused')) }), base);
    try {
      await assert.rejects(cache.materialize(req));
      assert.deepEqual(readdirSync(join(cache.root, 'verified')), []);
      assert.deepEqual(readdirSync(join(cache.root, 'staging')), []);
    } finally { await cache.close(); }
  }
  rmSync(base, { recursive: true, force: true });
});

test('cache aborts a pending fetch on cancellation or close; scoped 429 leaves no file', async () => {
  const base = mkdtempSync(join(tmpdir(), 'routed-cache-test-'));
  const cache = createRoutedFileCache(async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }), base);
  const controller = new AbortController();
  try {
    const pending = cache.materialize(req, controller.signal);
    controller.abort();
    await assert.rejects(pending);
    assert.deepEqual(readdirSync(join(cache.root, 'verified')), []);
    const another = cache.materialize(req);
    const refused = assert.rejects(another);
    await cache.close();
    await refused;
    assert.equal(existsSync(cache.root), false);
    const limited = createRoutedFileCache(async () => { throw new Error('scoped 429'); }, base);
    try {
      await assert.rejects(limited.materialize(req), /scoped 429/);
      assert.deepEqual(readdirSync(join(limited.root, 'verified')), []);
    } finally { await limited.close(); }
  } finally { await cache.close(); rmSync(base, { recursive: true, force: true }); }
});

function order(): GetOrderResponse {
  return { text: '', workflow: 'wf', run: 'run', lease: { claimed: true }, order: {
    workflow: 'wf', run: 'run', step: 'consumer', key: '', defDigest: 'digest',
    inputs: ['input'], outputs: ['output'], consumes: { input: { nested: [pointer] } },
    consumedFingerprint: {}, owes: [{ path: 'output', version: 0,
      judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  } };
}

function context(): ToolCallContext {
  const callbacks: Array<() => void> = [];
  return { cancelled: false, onCancel: cb => callbacks.push(cb), sendProgress: () => {} };
}

function cancellableContext() {
  const callbacks: Array<() => void> = [];
  let cancelled = false;
  return { ctx: { get cancelled() { return cancelled; },
    onCancel: (cb: () => void) => callbacks.push(cb), sendProgress: () => {} } as ToolCallContext,
    cancel() { cancelled = true; for (const cb of callbacks) cb(); } };
}

test('only routed mount reads an exact nested pointer from the gated order', async () => {
  const calls: unknown[] = [];
  const hub = { getOrder: async () => order(), heartbeat: async () => ({ text: '' }),
    release: async () => ({ text: '' }) } as unknown as HubClient;
  const common = { hub, workflow: 'wf', run: 'run', workdir: process.cwd(),
    sleep: async () => {}, now: () => 0, err: () => {},
    modelOrderVerifier: async () => ({ ok: true as const }),
    consumedVerifier: async (value: NonNullable<GetOrderResponse['order']>) =>
      ({ ok: true as const, order: value, warnings: [] }),
  };
  const ordinary = createHoldMcp(common);
  assert.equal(ordinary.tools.some(tool => tool.name === 'get_file_artifact'), false);
  const mount = createHoldMcp({ ...common,
    downloadFile: async request => { calls.push(request); return { file: '/verified/file',
      size: pointer.size, contentType: pointer.contentType }; },
    discardDownloadedFile: async () => {},
  });
  const get = mount.tools.find(tool => tool.name === 'get_file_artifact')!;
  assert.ok(get);
  const beforeOrder = await get.handler({ path: 'input', key: pointer.__file }, context());
  assert.equal(beforeOrder.isError, true);
  assert.equal(calls.length, 0);
  const shown = await mount.tools.find(tool => tool.name === 'get_order')!.handler({}, context());
  assert.equal(shown.isError, undefined);
  for (const bad of [{ path: 'other', key: pointer.__file },
    { path: 'input', key: 'orgs/org/artifacts/wf/files/other' }]) {
    assert.equal((await get.handler(bad, context())).isError, true);
  }
  assert.equal(calls.length, 0);
  const result = await get.handler({ path: 'input', key: pointer.__file }, context());
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ workflow: 'wf', run: 'run', path: 'input', pointer }]);
  assert.equal(JSON.parse(result.content[0]!.text).file, '/verified/file');
});

test('routed file tool cancels an in-flight download and refuses after terminal', async () => {
  let aborts = 0;
  const hub = { getOrder: async () => order(), heartbeat: async () => ({ text: '' }),
    release: async () => ({ text: '' }) } as unknown as HubClient;
  const mount = createHoldMcp({ hub, workflow: 'wf', run: 'run', workdir: process.cwd(),
    sleep: async () => {}, now: () => 0, err: () => {},
    modelOrderVerifier: async () => ({ ok: true }),
    consumedVerifier: async value => ({ ok: true, order: value, warnings: [] }),
    downloadFile: async (_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { aborts++; reject(new Error('cancelled')); }, { once: true });
    }), discardDownloadedFile: async () => {},
  });
  await mount.tools.find(tool => tool.name === 'get_order')!.handler({}, context());
  const get = mount.tools.find(tool => tool.name === 'get_file_artifact')!;
  const request = cancellableContext();
  const pending = get.handler({ path: 'input', key: pointer.__file }, request.ctx);
  request.cancel();
  assert.equal((await pending).isError, true);
  assert.equal(aborts, 1);
  mount.loop.stop('done', { release: false });
  assert.equal((await get.handler({ path: 'input', key: pointer.__file }, context())).isError, true);
});

test('routed holder submit omits local machine proof with an origin while ordinary policy remains separate', async () => {
  const submissions: unknown[] = [];
  const hub = { getOrder: async () => order(), heartbeat: async () => ({ text: '' }),
    release: async () => ({ text: '' }),
    submit: async (value: unknown) => { submissions.push(value); return { text: 'accepted', outcome: 'green' }; },
  } as unknown as HubClient;
  const mount = createHoldMcp({ hub, workflow: 'wf', run: 'run', workdir: process.cwd(),
    origin: 'https://hub.example', routedSubmit: true,
    sleep: async () => {}, now: () => 0, err: () => {},
    modelOrderVerifier: async () => ({ ok: true }),
    consumedVerifier: async value => ({ ok: true, order: value, warnings: [] }),
  });
  const result = await mount.tools.find(tool => tool.name === 'submit')!.handler(
    { path: 'output', value: { result: true }, done: true }, context());
  assert.equal(result.isError, undefined);
  assert.deepEqual(submissions, [{ workflow: 'wf', run: 'run', path: 'output',
    value: { result: true }, done: true }]);
});
