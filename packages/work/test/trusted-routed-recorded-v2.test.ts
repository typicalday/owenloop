import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import type { OrderPacket, ReferenceRouting } from '../src/hub/types.ts';
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
