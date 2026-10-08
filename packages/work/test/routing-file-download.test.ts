import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHubClient } from '../src/hub/client.ts';
import { createRoutingChildClient } from '../src/hub/routing-child-client.ts';
import type { DecisionBindingV1, FileArtifactPointer, ReferenceRouting } from '../src/hub/types.ts';
import { createRoutingBroker } from '../src/shift/routing-broker.ts';
import type { ChildReservation } from '../src/shift/state.ts';

const origin = 'https://hub.example';
const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const credential = `rs1.${sessionId}.${'x'.repeat(43)}`;
const identity = { orgId: 'org', principalId: 'agent', sessionId, shiftId: 'shf_service', expiresAt: 90_000 };
const binding: DecisionBindingV1 = {
  orgId: 'org', runId: 'wf', frameId: 'frame',
  def: { bundleDigest: 'sha256:bundle', workflowName: 'wf' }, subjectKey: 'subject',
  evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates', policyDigest: 'sha256:policy',
  revisions: { definition: '1', candidates: '1', policy: '1', authority: '1', rolePolicy: '1',
    roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
  issuedAt: 1_000, expiresAt: 80_000, authority: { principalId: 'agent', sessionId },
};
const routing = {
  claim: { state: 'claimed', claimId: 'run', decisionId: 'decision', binding,
    invocationId: null, orderId: 'run', attemptId: 'run', principalId: 'agent',
    sessionId, shiftId: identity.shiftId },
  decision: { decisionId: 'decision', binding, status: 'applied', applied: null, effect: null },
  preference: { offer: null, tuples: [], role: 'implementation', rolePolicy: null,
    rosterRevision: 'roster-v1', expiresAt: 70_000 },
} as ReferenceRouting;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++)
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  assert.equal(predicate(), true);
}

function bytesResponse(bytes: Uint8Array, pointer: FileArtifactPointer): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'Content-Length': String(pointer.size), 'Content-Type': pointer.contentType,
    'X-File-Hash': pointer.hash } });
}

async function fixture(kind: 'exec' | 'agent-run', pointer: FileArtifactPointer,
  fileReply: (signal?: AbortSignal) => Response | Promise<Response>) {
  let live: typeof identity | undefined = { ...identity };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => live && ({ ...live, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/api/get_order')) return Response.json({ text: 'ok', workflow: 'wf', run: 'run',
        lease: { claimed: true }, order: { workflow: 'wf', run: 'run', step: 'work', key: '', defDigest: 'digest',
          inputs: ['seed'], outputs: ['out'], owes: [{ path: 'out' }],
          consumes: { seed: { nested: { file: pointer } } } } });
      return fileReply(init?.signal ?? undefined);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  const reservation: ChildReservation = { recordType: 'reservation', workflow: 'wf', run: 'run',
    childKind: kind, reservedAt: 1_000, token: 'a'.repeat(32) };
  const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => live, hub });
  grant.activate({ workflow: 'wf', run: 'run', kind, pid: 9001, spawnedAt: 1_000,
    gateToken: reservation.token });
  const cap = kind === 'agent-run' ? grant.holder! : grant;
  const client = createRoutingChildClient({ broker: cap, reservation });
  await client.getOrder({ workflow: 'wf', run: 'run', holder: kind === 'exec'
    ? { kind: 'exec', id: `${hostname()}:9001`, shiftId: identity.shiftId }
    : { kind: 'session', id: sessionId, shiftId: identity.shiftId } });
  return { broker, grant, client, requests, revoke: () => { live = undefined; } };
}

test('role and holder download exact consumed pointer through session-scoped GET without JSON byte frames', async () => {
  const bytes = new Uint8Array(33 * 1024 * 1024 + 1).fill(7);
  const pointer: FileArtifactPointer = { __file: 'orgs/org/artifacts/wf/files/hash', hash: sha(bytes),
    size: bytes.byteLength, contentType: 'application/octet-stream' };
  for (const kind of ['exec', 'agent-run'] as const) {
    const f = await fixture(kind, pointer, () => bytesResponse(bytes, pointer));
    try {
      const read = await f.client.getFileArtifactStream({ workflow: 'wf', run: 'run', path: 'seed', pointer });
      let count = 0;
      for await (const chunk of read.chunks) count += chunk.byteLength;
      await read.verified;
      assert.equal(count, bytes.byteLength);
      const get = f.requests.find(entry => entry.init?.method === 'GET')!;
      assert.equal(get.url, `${origin}/api/routing_file_artifacts/v1?workflow=wf&run=run&key=${encodeURIComponent(pointer.__file)}`);
      assert.equal(new Headers(get.init?.headers).get('Authorization'), 'Bearer enrolled');
      assert.equal(new Headers(get.init?.headers).get('X-Owenloop-Routing-Session'), credential);
      assert.equal(get.init?.redirect, 'error');
      assert.equal(f.requests.length, 2);
    } finally { await f.broker.close(); }
  }
});

test('download broker refuses wrong consumed path, pointer and run before any Hub GET', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const pointer: FileArtifactPointer = { __file: 'orgs/org/artifacts/wf/files/hash', hash: sha(bytes),
    size: bytes.length, contentType: 'application/octet-stream' };
  const f = await fixture('exec', pointer, () => bytesResponse(bytes, pointer));
  try {
    for (const request of [
      { workflow: 'wf', run: 'run', path: 'other', pointer },
      { workflow: 'wf', run: 'run', path: 'seed', pointer: { ...pointer, hash: '0'.repeat(64) } },
    ]) await assert.rejects(f.client.getFileArtifactStream(request));
    assert.throws(() => f.client.getFileArtifactStream({ workflow: 'wf', run: 'another',
      path: 'seed', pointer }), /binding refused/);
    assert.equal(f.requests.length, 1);
  } finally { await f.broker.close(); }
});

test('download never completes on corrupt, short or long bytes, or a scoped 429', async () => {
  const original = new Uint8Array([1, 2, 3]);
  const pointer: FileArtifactPointer = { __file: 'orgs/org/artifacts/wf/files/hash', hash: sha(original),
    size: original.length, contentType: 'application/octet-stream' };
  for (const value of [new Uint8Array([1, 2, 4]), new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4])]) {
    const f = await fixture('exec', pointer, () => bytesResponse(value, pointer));
    try {
      const read = await f.client.getFileArtifactStream({ workflow: 'wf', run: 'run', path: 'seed', pointer });
      await assert.rejects(async () => { for await (const _chunk of read.chunks) { /* discard unverified bytes */ } });
      await assert.rejects(read.verified);
    } finally { await f.broker.close(); }
  }
  const rate = await fixture('exec', pointer, () => new Response(null, { status: 429,
    headers: { 'Retry-After': '3' } }));
  try {
    await assert.rejects(rate.client.getFileArtifactStream({ workflow: 'wf', run: 'run', path: 'seed', pointer }),
      (error: unknown) => error instanceof Error);
  } finally { await rate.broker.close(); }
});

test('revocation while scoped GET is pending cancels the returned source before any byte is sent', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const pointer: FileArtifactPointer = { __file: 'orgs/org/artifacts/wf/files/hash', hash: sha(bytes),
    size: bytes.length, contentType: 'application/octet-stream' };
  let entered!: () => void;
  const inFlight = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let cancelled = false;
  const f = await fixture('exec', pointer, async () => {
    entered();
    await gate;
    return new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Length': '3', 'Content-Type': pointer.contentType,
      'X-File-Hash': pointer.hash } });
  });
  try {
    const pending = f.client.getFileArtifactStream({ workflow: 'wf', run: 'run', path: 'seed', pointer });
    await inFlight;
    f.revoke();
    resume();
    await assert.rejects(pending);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally { await f.broker.close(); }
});

test('revocation during a download refuses remaining bytes and cancels the source', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const pointer: FileArtifactPointer = { __file: 'orgs/org/artifacts/wf/files/hash', hash: sha(bytes),
    size: bytes.length, contentType: 'application/octet-stream' };
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let cancelled = false;
  let part = 0;
  const f = await fixture('exec', pointer, () => new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (part++ === 0) { controller.enqueue(new Uint8Array([1])); return; }
      await gate;
      controller.enqueue(new Uint8Array([2, 3]));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Length': '3', 'Content-Type': pointer.contentType,
    'X-File-Hash': pointer.hash } }));
  try {
    const read = await f.client.getFileArtifactStream({ workflow: 'wf', run: 'run', path: 'seed', pointer });
    const iterator = read.chunks[Symbol.asyncIterator]();
    assert.deepEqual(iterator.next && (await iterator.next()).value, Buffer.from([1]));
    f.revoke();
    resume();
    await assert.rejects(iterator.next());
    await eventually(() => cancelled);
  } finally { await f.broker.close(); }
});

test('consumer disconnect cancels the Hub GET instead of leaving a live stream', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const pointer: FileArtifactPointer = { __file: 'orgs/org/artifacts/wf/files/hash', hash: sha(bytes),
    size: bytes.length, contentType: 'application/octet-stream' };
  let cancelled = false;
  let part = 0;
  const f = await fixture('exec', pointer, () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (part++ === 0) controller.enqueue(new Uint8Array([1]));
      else return new Promise<void>(() => {});
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Length': '3', 'Content-Type': pointer.contentType,
    'X-File-Hash': pointer.hash } }));
  try {
    const read = await f.client.getFileArtifactStream({ workflow: 'wf', run: 'run', path: 'seed', pointer });
    const iterator = read.chunks[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, Buffer.from([1]));
    await iterator.return?.();
    await eventually(() => cancelled);
  } finally { await f.broker.close(); }
});

test('upload child waits for source EOF after early accepted ack and socket reset', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'routing-upload-ack-'));
  const socketPath = join(directory, 'broker.sock');
  let ack!: () => void;
  const acked = new Promise<void>(resolve => { ack = resolve; });
  let release!: () => void;
  const eof = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(socket => {
    socket.on('error', () => {});
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, Buffer.from(chunk)]);
      const newline = received.indexOf(0x0a);
      if (newline < 0 || received.length - newline - 1 < 3) return;
      socket.write(JSON.stringify({ ok: true, value: { text: 'stored', __file: 'key', hash: '0'.repeat(64),
        size: 3, contentType: 'application/octet-stream' } }) + '\n', () => {
        ack(); socket.destroy();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const client = createRoutingChildClient({ broker: { socketPath, cap: 'a'.repeat(64) },
      reservation: { workflow: 'wf', run: 'run' } });
    let finished = false;
    const pending = client.putFileArtifactStream({ workflow: 'wf', size: 3,
      chunks: (async function* () { yield new Uint8Array([1, 2, 3]); await eof; })(),
      contentType: 'application/octet-stream' }).then(value => { finished = true; return value; });
    await acked;
    assert.equal(finished, false);
    release();
    assert.equal((await pending).size, 3);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
