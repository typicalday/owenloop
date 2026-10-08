import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { parseConsume, parseProduce } from '../../../src/paths.ts';
import type { StepDef } from '../../../src/types.ts';
import { createHubClient } from '../src/hub/client.ts';
import { createRoutingBackoff } from '../src/shift/runtime.ts';
import { createTrustedRoutedInputV2Admission } from '../src/hosted/trusted-input-admission.ts';
import { createBrokerRoutedReferenceV2Reader, createTrustedRoutedReferenceV2Reader,
  parseRoutedClaimV2, parseRoutedReferenceV2,
  type RoutedClaimV2, type RoutedReferenceV2 } from '../src/hosted/trusted-routed-reference-v2.ts';
import type { OrderPacket, ReferenceRouting } from '../src/hub/types.ts';

const expected = { workflow: 'wf_root', run: 'run_example' };
const session = 'rs1.rs_00000000-0000-4000-8000-000000000000.' + 'A'.repeat(43);
const future = Date.now() + 600_000;
const pair = (): { reference: RoutedReferenceV2; claim: RoutedClaimV2 } => {
  const routing = {
    claim: { claimId: expected.run, sessionId: 'rs_00000000-0000-4000-8000-000000000000', shiftId: 'shf_example' },
    decision: { decisionId: 'decision_1' },
    preference: { rosterRevision: 'a'.repeat(64), expiresAt: future },
  } as unknown as ReferenceRouting;
  const binding = { rootWorkflow: expected.workflow, frameWorkflow: 'wf_child', run: expected.run,
    claimId: expected.run, decisionId: 'decision_1', sessionId: routing.claim.sessionId,
    shiftId: routing.claim.shiftId, orderDigest: 'b'.repeat(64), authorityRevision: 'c'.repeat(64),
    rosterRevision: routing.preference.rosterRevision, routingDigest: valueDigestHex(routing),
    preferenceExpiresAt: future };
  const order = { workflow: 'wf_child', run: expected.run, step: 'planner', key: '',
    defDigest: 'd'.repeat(64), inputs: ['optional'], outputs: ['plan'], consumes: {},
    consumedFingerprint: { optional: 1 }, owes: [{ path: 'plan', version: 1 }], routing } as unknown as OrderPacket;
  const reference: RoutedReferenceV2 = { protocol: 'trusted-routed-reference-read-v2', state: 'available',
    ...expected, order, inputs: [{ path: 'optional', version: 1, present: false }],
    lease: { claimed: true }, binding };
  const claim: RoutedClaimV2 = { protocol: 'routing-claim-read-v2', state: 'available',
    ...expected, routing, binding };
  return { reference, claim };
};

test('routed v2 parser requires exact root, frame, routing and closed refusal protocol', () => {
  const valid = pair();
  assert.deepEqual(parseRoutedReferenceV2(valid.reference, expected), valid.reference);
  assert.deepEqual(parseRoutedClaimV2(valid.claim, expected), valid.claim);
  const indexed = structuredClone(valid.reference) as Extract<RoutedReferenceV2, { state: 'available' }>;
  indexed.order.inputs = ['rows[2]'];
  indexed.order.consumes = { 'rows[2]': { value: 1 } };
  indexed.order.consumedFingerprint = { 'rows[2]': 2 };
  indexed.inputs = [{ path: 'rows[2]', version: 2, present: true, value: { value: 1 } }];
  assert.deepEqual(parseRoutedReferenceV2(indexed, expected), indexed);
  const bad = (change: (value: ReturnType<typeof pair>) => void) => {
    const value = structuredClone(pair());
    change(value);
    assert.throws(() => parseRoutedReferenceV2(value.reference, expected));
  };
  bad(value => { (value.reference as Extract<RoutedReferenceV2, { state: 'available' }>).binding.frameWorkflow = 'wf_other'; });
  bad(value => { (value.reference as Extract<RoutedReferenceV2, { state: 'available' }>).binding.routingDigest = 'e'.repeat(64); });
  bad(value => { (value.reference as Extract<RoutedReferenceV2, { state: 'available' }>).inputs[0]!.version = 2; });
  bad(value => { (value.reference as Extract<RoutedReferenceV2, { state: 'available' }>).order.routing = undefined; });
  assert.throws(() => parseRoutedReferenceV2({ ...valid.reference, protocol: 'trusted-reference-read-v2' }, expected));
  assert.throws(() => parseRoutedClaimV2({ ...valid.claim, extra: true }, expected));
  assert.deepEqual(parseRoutedReferenceV2({ protocol: 'trusted-routed-reference-read-v2',
    state: 'unsupported-feedback', ...expected }, expected), {
    protocol: 'trusted-routed-reference-read-v2', state: 'unsupported-feedback', ...expected });
});

test('parent-owned HTTPS reads both scoped routes with original bearer/session and refuses downgrade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'routed-v2-https-'));
  try {
    const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert],
    { stdio: 'ignore' });
    const observed: string[] = [];
    let status = 200, cache = 'no-store', rateLimits = 0, monotonic = 0;
    const backoff = createRoutingBackoff(() => monotonic);
    let witness = pair();
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      observed.push(req.url!);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer worker-secret');
      assert.equal(req.headers['x-owenloop-routing-session'], session);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), expected);
      assert.ok(['/api/routing_reference_order/v2', '/api/read_routing_claim/v2'].includes(req.url!));
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': cache,
	...(status === 302 ? { location: 'https://elsewhere.example/steal' } : {}),
	...(status === 429 ? { 'retry-after': '2' } : {}) });
      res.end(JSON.stringify(req.url === '/api/routing_reference_order/v2' ? witness.reference : witness.claim));
    });
    await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const reader = createTrustedRoutedReferenceV2Reader({ origin: `https://localhost:${address.port}`,
	expected, getToken: async () => 'worker-secret', getSession: async () => session,
	trustedCa: readFileSync(cert), beforeRequest: backoff.beforeRequest,
	onRateLimit: error => { rateLimits++; backoff.onRateLimit(error);
	  assert.equal(error.status, 429); assert.equal(error.retryAfterMs, 2_000); } });
      assert.deepEqual(await reader.read(), witness);
      assert.deepEqual(observed, ['/api/routing_reference_order/v2', '/api/read_routing_claim/v2']);
      status = 302;
      await assert.rejects(reader.read());
      assert.equal(observed.length, 3, 'redirect target receives no credentials');
      status = 404;
      await assert.rejects(reader.read());
      status = 429;
      await assert.rejects(reader.read());
      assert.equal(rateLimits, 1);
      const beforeBlocked = observed.length;
      await assert.rejects(reader.read());
      assert.equal(observed.length, beforeBlocked, 'preexisting backoff refuses v2 before network');
      let ordinaryFetches = 0;
      const ordinary = createHubClient({ origin: 'https://hub.example', getToken: async () => 'worker-secret',
	routingSession: { allowedOrigin: 'https://hub.example', get: () => ({
	  sessionId: 'rs_00000000-0000-4000-8000-000000000000', shiftId: 'shf_example',
	  credential: session, expiresAt: Date.now() + 60_000 }), beforeRequest: backoff.beforeRequest },
	fetchImpl: (async () => { ordinaryFetches++; throw new Error('unexpected ordinary fetch'); }) as typeof fetch });
      await assert.rejects(ordinary.readRoutingClaim({ workflow: expected.workflow, run: expected.run }));
      assert.equal(ordinaryFetches, 0, 'v2 429 gates the shared ordinary routed client');
      monotonic = 2_000;
      status = 200;
      cache = 'max-age=60';
      await assert.rejects(reader.read());
      cache = 'no-store';
      witness = { ...pair(), reference: { protocol: 'trusted-routed-reference-read-v2',
	state: 'unsupported-feedback', ...expected } };
      assert.equal((await reader.read()).reference.state, 'unsupported-feedback');
      assert.throws(() => createTrustedRoutedReferenceV2Reader({ origin: 'http://localhost', expected,
	getToken: async () => 'secret', getSession: async () => session }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stalled 429 body still records Retry-After from response headers before transport timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'routed-v2-429-'));
  try {
    const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert],
    { stdio: 'ignore' });
    let requests = 0, clock = 0, observed = 0;
    const backoff = createRoutingBackoff(() => 0);
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      requests++;
      for await (const _chunk of req) { /* consume bounded request */ }
      res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' });
      res.flushHeaders(); // deliberately never send a body or EOF
    });
    await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const reader = createTrustedRoutedReferenceV2Reader({ origin: `https://localhost:${address.port}`,
	expected, trustedCa: readFileSync(cert), now: () => clock,
	getToken: async () => 'worker-secret', getSession: async () => { clock = 4_950; return session; },
	beforeRequest: backoff.beforeRequest, onRateLimit: error => {
	  observed++; backoff.onRateLimit(error); assert.equal(error.retryAfterMs, 5_000);
	} });
      await assert.rejects(reader.read());
      assert.equal(observed, 1);
      await assert.rejects(reader.read());
      assert.equal(requests, 1, 'stalled-body 429 arms shared backoff before another request');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('oversize 429 body records Retry-After before response-size refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'routed-v2-429-large-'));
  try {
    const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert],
    { stdio: 'ignore' });
    let observed = 0;
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      for await (const _chunk of req) { /* consume bounded request */ }
      res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '7' });
      res.end(Buffer.alloc(2_000_001));
    });
    await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const reader = createTrustedRoutedReferenceV2Reader({ origin: `https://localhost:${address.port}`,
	expected, trustedCa: readFileSync(cert), getToken: async () => 'worker-secret',
	getSession: async () => session, onRateLimit: error => {
	  observed++; assert.equal(error.retryAfterMs, 7_000);
	} });
      await assert.rejects(reader.read());
      assert.equal(observed, 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('routed v2 binder binds both Service reads and local optional input without dropping routing digest', async () => {
  const wire = pair();
  const local = { name: 'planner', consumes: [parseConsume('optional')],
    produces: [parseProduce('plan')] } as StepDef;
  let verifications = 0;
  const admission = createTrustedRoutedInputV2Admission({ reader: { read: async () => wire }, expected,
    instructions: { resolveCommand: async () => ({ ok: false, kind: 'unknown-step', reason: 'unused' }),
      resolveStep: async () => ({ ok: true, step: local }),
      resolveHostedStep: async () => ({ ok: true, step: local, inputNames: ['optional'],
	declaredInputs: [{ name: 'optional', producer: 'human', seedOwed: false }], callsProducers: {} }) },
    consumedVerifier: async order => { verifications++; assert.equal(order.routing, undefined);
      return { ok: true, order, warnings: [] }; } });
  const direct = wire.reference as Extract<RoutedReferenceV2, { state: 'available' }>;
  const privateOrder = { ...direct.order, owes: [{ path: 'plan', version: 1,
    reasons: [], judgmentRejects: 0, schemaRejects: 0 }] } as OrderPacket;
  const accepted = await admission.observe(privateOrder);
  assert.equal(accepted.ok, true);
  assert.equal(verifications, 1);
  assert.deepEqual(await admission.observe({ ...privateOrder, routing: { ...privateOrder.routing!,
    preference: { ...privateOrder.routing!.preference, rosterRevision: 'e'.repeat(64) } } }),
    { ok: false, reason: 'routed-binding-changed' });
  wire.claim = { ...wire.claim, binding: { ...(wire.claim as Extract<RoutedClaimV2, { state: 'available' }>).binding,
    orderDigest: 'f'.repeat(64) } } as RoutedClaimV2;
  assert.deepEqual(await admission.observe(privateOrder), { ok: false, reason: 'routed-binding-changed' });
  assert.equal(verifications, 1);
});

test('child broker reader accepts only its fixed root/run and rechecks elapsed observation time', async () => {
  const value = pair();
  let clock = 1_000;
  const calls: string[] = [];
  const client = {
    readRoutedReferenceV2: async (req: typeof expected) => {
      calls.push('reference'); assert.deepEqual(req, expected); return value.reference;
    },
    readRoutingClaimV2: async (req: typeof expected) => {
      calls.push('claim'); assert.deepEqual(req, expected); return value.claim;
    },
  };
  const reader = createBrokerRoutedReferenceV2Reader(client, expected, () => clock);
  assert.deepEqual(await reader.read(), value);
  assert.deepEqual(calls, ['reference', 'claim']);
  client.readRoutingClaimV2 = async () => { clock += 5_000; return value.claim; };
  await assert.rejects(reader.read(), /observation expired/);
  client.readRoutingClaimV2 = async () => ({ ...value.claim, workflow: 'wf_wrong' });
  clock = 1_000;
  await assert.rejects(reader.read(), /envelope mismatch/);
});
