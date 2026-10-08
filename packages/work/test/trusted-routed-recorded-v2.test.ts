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
import type { OrderPacket, ReferenceRouting } from '../src/hub/types.ts';
import { bindTrustedRoutedInputV2 } from '../src/hosted/trusted-input-admission.ts';
import {
  createBrokerRecordedRoutedV2Reader, createRecordedRoutedV2Reader,
  parseRecordedClaimV2, parseRecordedReferenceV2,
  type RecordedClaimV2, type RecordedReferenceV2,
} from '../src/hosted/trusted-routed-recorded-v2.ts';

const expected = { workflow: 'wf_root', run: 'run_example' };
const session = 'rs1.rs_00000000-0000-4000-8000-000000000000.' + 'A'.repeat(43);
const pair = (): { reference: RecordedReferenceV2; claim: RecordedClaimV2 } => {
  const routing = {
    claim: { claimId: expected.run, attemptId: 'attempt_distinct',
      sessionId: 'rs_00000000-0000-4000-8000-000000000000', shiftId: 'shf_example' },
    decision: { decisionId: 'decision_1' },
    preference: { rosterRevision: 'a'.repeat(64), expiresAt: 1_000 },
  } as unknown as ReferenceRouting;
  const binding = { rootWorkflow: expected.workflow, frameWorkflow: 'wf_child', run: expected.run,
    claimId: expected.run, decisionId: 'decision_1', sessionId: routing.claim.sessionId,
    shiftId: routing.claim.shiftId, orderDigest: 'b'.repeat(64), authorityRevision: 'c'.repeat(64),
    rosterRevision: routing.preference.rosterRevision, routingDigest: valueDigestHex(routing),
    preferenceExpiresAt: 1_000,
    recordedOccurrence: { reservationId: 'lr_one', reportDigest: 'e'.repeat(64),
      recordedAt: 2_000, attemptId: 'attempt_distinct' } };
  const order = { workflow: 'wf_child', run: expected.run, step: 'planner', key: '',
    defDigest: 'd'.repeat(64), inputs: [], outputs: ['plan'], consumes: {},
    consumedFingerprint: {}, owes: [{ path: 'plan', version: 1 }], routing } as unknown as OrderPacket;
  return {
    reference: { protocol: 'trusted-routed-recorded-reference-read-v2', state: 'available',
      ...expected, order, inputs: [], lease: { claimed: true }, binding },
    claim: { protocol: 'routing-recorded-claim-read-v2', state: 'available',
      ...expected, routing, binding },
  };
};

test('recorded parser binds exact occurrence and keeps elapsed startup preference readable', () => {
  const valid = pair();
  assert.deepEqual(parseRecordedReferenceV2(valid.reference, expected), valid.reference);
  assert.deepEqual(parseRecordedClaimV2(valid.claim, expected), valid.claim);
  const bad = (change: (value: ReturnType<typeof pair>) => void) => {
    const value = structuredClone(pair());
    change(value);
    assert.throws(() => parseRecordedReferenceV2(value.reference, expected));
  };
  bad(value => { (value.reference as Extract<RecordedReferenceV2, { state: 'available' }>).
    binding.recordedOccurrence.attemptId = 'other'; });
  bad(value => { (value.reference as Extract<RecordedReferenceV2, { state: 'available' }>).
    binding.recordedOccurrence.reportDigest = 'not-a-digest'; });
  bad(value => { ((value.reference as Extract<RecordedReferenceV2, { state: 'available' }>).
    binding.recordedOccurrence as unknown as Record<string, unknown>).extra = true; });
  bad(value => { (value.reference as Extract<RecordedReferenceV2, { state: 'available' }>).
    binding.routingDigest = 'f'.repeat(64); });
  assert.throws(() => parseRecordedClaimV2({ ...valid.claim, protocol: 'routing-claim-read-v2' }, expected));
  assert.deepEqual(parseRecordedReferenceV2({ protocol: 'trusted-routed-recorded-reference-read-v2',
    state: 'unsupported-feedback', ...expected }, expected), {
    protocol: 'trusted-routed-recorded-reference-read-v2', state: 'unsupported-feedback', ...expected });
});

test('broker observation refuses a mixed recorded binding or routing sidecar', async () => {
  const valid = pair();
  const mixed = structuredClone(valid.claim) as Extract<RecordedClaimV2, { state: 'available' }>;
  mixed.binding.recordedOccurrence.recordedAt++;
  const client = { readLiveRoutedReferenceV2: async () => valid.reference,
    readLiveRoutingClaimV2: async () => mixed };
  await assert.rejects(createBrokerRecordedRoutedV2Reader(client, expected).read(), /occurrence changed/);
  mixed.binding.recordedOccurrence.recordedAt--;
  mixed.routing = { ...mixed.routing, preference: { ...mixed.routing.preference,
    expiresAt: 9_999 } };
  mixed.binding.routingDigest = valueDigestHex(mixed.routing);
  await assert.rejects(createBrokerRecordedRoutedV2Reader(client, expected).read());
  await assert.rejects(createBrokerRecordedRoutedV2Reader({
    readLiveRoutedReferenceV2: async () => valid.reference,
    readLiveRoutingClaimV2: async () => ({ protocol: 'routing-recorded-claim-read-v2',
      state: 'unavailable', ...expected }),
  }, expected).read(), /claim unavailable/);
});

test('recorded admission keeps human values and input-derived cwd after launch preference expires', async () => {
  const wire = pair();
  const reference = wire.reference as Extract<RecordedReferenceV2, { state: 'available' }>;
  reference.order.inputs = ['human'];
  reference.order.consumes = { human: { requested: 'approved' } };
  reference.order.consumedFingerprint = { human: 2 };
  reference.order.workdir = '/tmp/verified-workdir';
  reference.inputs = [{ path: 'human', version: 2, present: true,
    value: { requested: 'approved' } }];
  reference.workdirInput = { stem: 'where', version: 4,
    value: { cwd: '/tmp/verified-workdir' } };
  const privateOrder = { ...reference.order, owes: [{ path: 'plan', version: 1,
    reasons: [], judgmentRejects: 0, schemaRejects: 0 }] } as OrderPacket;
  const step = { name: 'planner', consumes: [parseConsume('human')],
    produces: [parseProduce('plan')], workdirFrom: 'where.cwd' } as StepDef;
  let elapsed = 10;
  const args = { phase: 'recorded-live' as const, pair: wire, privateOrder, expected,
    now: () => 2_000, monotonicNow: () => elapsed,
    instructions: { resolveCommand: async () => ({ ok: false as const,
      kind: 'unknown-step' as const, reason: 'unused' }),
    resolveStep: async () => ({ ok: true as const, step }),
    resolveHostedStep: async () => ({ ok: true as const, step,
      inputNames: ['human', 'where'], declaredInputs: [
	{ name: 'human', producer: 'human' as const, seedOwed: true },
	{ name: 'where', producer: 'human' as const, seedOwed: true }], callsProducers: {} }) },
    consumedVerifier: async (order: OrderPacket) => ({ ok: true as const, order, warnings: [] }) };
  const admitted = await bindTrustedRoutedInputV2(args);
  assert.equal(admitted.ok, true);
  if (admitted.ok) {
    assert.equal(admitted.phase, 'recorded-live');
    assert.ok(admitted.occurrenceDigest);
    assert.equal(admitted.order.workdir, '/tmp/verified-workdir');
  }
  assert.deepEqual(await bindTrustedRoutedInputV2({ ...args, phase: 'prestart' }),
    { ok: false, reason: 'routed-reference-v2-malformed' });
  const changed = structuredClone(wire);
  (changed.reference as Extract<RecordedReferenceV2, { state: 'available' }>).inputs[0]!.value =
    { requested: 'changed' };
  assert.deepEqual(await bindTrustedRoutedInputV2({ ...args, pair: changed }),
    { ok: false, reason: 'witness-value-mismatch' });
  const moved = structuredClone(wire);
  (moved.reference as Extract<RecordedReferenceV2, { state: 'available' }>).workdirInput!.value =
    { cwd: '/tmp/other' };
  assert.deepEqual(await bindTrustedRoutedInputV2({ ...args, pair: moved }),
    { ok: false, reason: 'workdir-value-mismatch' });
  elapsed += 5_000;
  assert.deepEqual(await bindTrustedRoutedInputV2({ ...args, startedMonotonic: 10 }),
    { ok: false, reason: 'routed-observation-expired' });
});

test('recorded transport sends only fixed routes with original bearer and routing session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-recorded-https-'));
  try {
    const key = join(root, 'key.pem'), cert = join(root, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert],
    { stdio: 'ignore' });
    const calls: string[] = [];
    const witness = pair();
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer enrolled');
      assert.equal(req.headers['x-owenloop-routing-session'], session);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), expected);
      calls.push(req.url!);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(req.url === '/api/routing_reference_order/live/v2'
	? witness.reference : witness.claim));
    });
    await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const reader = createRecordedRoutedV2Reader({ origin: `https://localhost:${address.port}`,
	expected, getToken: async () => 'enrolled', getSession: async () => session,
	trustedCa: readFileSync(cert) });
      assert.deepEqual(await reader.readReference(), witness.reference);
      assert.deepEqual(await reader.readClaim(), witness.claim);
      assert.deepEqual(calls, ['/api/routing_reference_order/live/v2', '/api/read_routing_claim/live/v2']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
