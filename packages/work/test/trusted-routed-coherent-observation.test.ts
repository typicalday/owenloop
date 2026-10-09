import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { createCoherentRoutingReaders, parseCoherentObservation } from '../src/hosted/trusted-routed-coherent-observation.ts';

const scope = { workflow: 'wf_root', run: 'run_example', origin: 'https://hub.example', orgId: 'org_one' };
const session = 'rs1.rs_00000000-0000-4000-8000-000000000000.' + 'A'.repeat(43);
const frameDefRef = { bundleDigest: 'd'.repeat(64), workflowName: 'routing/parent' };
const childDefRef = { bundleDigest: 'e'.repeat(64), workflowName: 'routing/child' };
const selection = { rootWorkflow: scope.workflow, run: scope.run, frameWorkflow: 'wf_child', frameDefRef,
  parentWorkflow: 'wf_child', ancestry: [], edge: { parentDefRef: frameDefRef,
    callStep: 'delegate', callPath: 'folded', target: 'routing/child' } };
const key = { parentWorkflow: 'wf_child', parentDefRef: frameDefRef, callPath: 'folded', parentArtifactVersion: 1 };
function envelope(domain: 'structure' | 'folded' | 'order', recorded = false, origin = scope.origin) {
  const routing = { claim: { claimId: scope.run, attemptId: 'attempt_one',
    sessionId: 'rs_00000000-0000-4000-8000-000000000000', shiftId: 'shf_example' },
    decision: { decisionId: 'decision_1' }, preference: { rosterRevision: 'a'.repeat(64), expiresAt: Date.now() + 60_000 } };
  const binding = { rootWorkflow: scope.workflow, frameWorkflow: 'wf_child', run: scope.run,
    claimId: scope.run, decisionId: 'decision_1', sessionId: routing.claim.sessionId, shiftId: routing.claim.shiftId,
    orderDigest: 'b'.repeat(64), authorityRevision: 'c'.repeat(64), rosterRevision: routing.preference.rosterRevision,
    routingDigest: valueDigestHex(routing), preferenceExpiresAt: routing.preference.expiresAt,
    ...(recorded ? { recordedOccurrence: { reservationId: 'lr_one', reportDigest: 'f'.repeat(64),
      recordedAt: 2_000, attemptId: 'attempt_one' } } : {}) };
  const order = { workflow: 'wf_child', run: scope.run, step: 'command', key: '', defDigest: frameDefRef.bundleDigest,
    inputs: [], outputs: ['out'], consumes: {}, consumedFingerprint: {}, owes: [{ path: 'out', version: 1 }], routing };
  const pair = { protocol: recorded ? 'routed-recorded-input-pair-v2' : 'routed-prestart-input-pair-v2',
    phase: recorded ? 'recorded-live' : 'prestart',
    reference: { protocol: recorded ? 'trusted-routed-recorded-reference-read-v2' : 'trusted-routed-reference-read-v2',
      state: 'available', workflow: scope.workflow, run: scope.run, order, inputs: [], lease: { claimed: true }, binding },
    claim: { protocol: recorded ? 'routing-recorded-claim-read-v2' : 'routing-claim-read-v2',
      state: 'available', workflow: scope.workflow, run: scope.run, routing, binding } };
  const receipt = domain === 'structure' ? { kind: 'root-bound-concrete-structure', rootWorkflow: scope.workflow,
    frameWorkflow: 'wf_child', frameDefRef, ancestry: [], edge: { ...selection.edge,
      kind: 'selected-native-concrete-child', parentWorkflow: 'wf_child', childWorkflow: 'wf_native_B', childDefRef } }
    : { kind: 'concrete-call', ...key, callStep: 'delegate', childWorkflow: 'wf_native_B', childDefRef,
      childOutcome: 'result', childOutcomeVersion: 1, foldedValueDigest: 'a'.repeat(64) };
  const member = domain === 'order' ? { text: 'full projection', workflow: 'wf_child', run: scope.run,
    order: { ...order, consumesProofRelay: { folded: { advisory: true } } }, lease: { claimed: true, heartbeatAt: 1 } }
    : { protocol: domain === 'structure' ? recorded ? 'owenloop-concrete-call-structure-recorded-v1' : 'owenloop-concrete-call-structure-v1'
      : recorded ? 'owenloop-concrete-call-recorded-v1' : 'owenloop-concrete-call-v1',
    state: 'available', workflow: scope.workflow, run: scope.run, origin, orgId: scope.orgId, binding,
    selected: { receipt, receiptDigest: valueDigestHex(receipt), ...(domain === 'folded' ? { proof: 'opaque-stored-proof' } : {}) },
    freshness: 'fresh-at-read', atomicLaunch: false };
  return { protocol: domain === 'structure' ? 'owenloop-concrete-structure-pair-v3'
    : domain === 'folded' ? 'owenloop-concrete-binding-pair-v3' : 'owenloop-routing-order-pair-v3',
  phase: pair.phase, state: 'available', workflow: scope.workflow, run: scope.run, origin, orgId: scope.orgId,
  pair, [domain]: member };
}

test('coherent envelopes bind exact phase/domain/root and enforce constituent bounds', () => {
  for (const domain of ['structure', 'folded', 'order'] as const) for (const recorded of [false, true]) {
    const wire = envelope(domain, recorded), phase = recorded ? 'recorded-live' : 'prestart';
    assert.ok(parseCoherentObservation(wire, domain, phase, scope).pair);
    for (const change of [ { phase: recorded ? 'prestart' : 'recorded-live' }, { workflow: 'other' },
      { origin: 'https://other.example' }, { extra: true }, { protocol: 'wrong-domain' } ])
      assert.throws(() => parseCoherentObservation({ ...wire, ...change }, domain, phase, scope));
    const mixed = structuredClone(wire);
    mixed.pair.claim.binding.orderDigest = '0'.repeat(64);
    assert.throws(() => parseCoherentObservation(mixed, domain, phase, scope));
  }
  const wire = envelope('structure'); let nested: Record<string, unknown> = {}; const deep = nested;
  for (let index = 0; index < 65; index++) { const next = {}; nested.next = next; nested = next; }
  assert.throws(() => parseCoherentObservation({ ...wire, structure: deep }, 'structure', 'prestart', scope));
  assert.throws(() => parseCoherentObservation({ ...wire, state: 'unavailable' }, 'structure', 'prestart', scope));
});

test('all six composite routes use one original-session request and never downgrade after refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coherent-routing-https-'));
  const cert = join(root, 'cert.pem'), tlsKey = join(root, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey,
    '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const observed: string[] = [];
  let available = true, mixed = false;
  const server = createServer({ key: readFileSync(tlsKey), cert: readFileSync(cert) }, async (req, res) => {
    for await (const _chunk of req) { /* bounded test-owned body discarded */ }
    assert.equal(req.headers.authorization, 'Bearer test-owned-bearer');
    assert.equal(req.headers['x-owenloop-routing-session'], session);
    observed.push(req.url!);
    const domain = req.url!.includes('structure') ? 'structure' : req.url!.includes('binding') ? 'folded' : 'order';
    const wire = envelope(domain, req.url!.includes('/live/'), `https://localhost:${(server.address() as { port: number }).port}`);
    if (mixed && domain === 'structure') (wire.structure as { binding: unknown }).binding = { changed: true };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(available ? wire : { protocol: wire.protocol, phase: wire.phase, state: 'unavailable',
      workflow: scope.workflow, run: scope.run }));
  });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  try {
    const origin = `https://localhost:${(server.address() as { port: number }).port}`;
    const reader = createCoherentRoutingReaders({ origin, orgId: scope.orgId, expected: scope,
      getToken: async () => 'test-owned-bearer', getSession: async () => session, trustedCa: readFileSync(cert) });
    for (const phase of ['prestart', 'recorded-live'] as const) {
      const selected = (await reader.structure(selection, phase)).selected;
      assert.ok(selected.kind === 'selected-native-concrete-child');
      assert.equal(selected.childWorkflow, 'wf_native_B');
      assert.equal((await reader.folded(key, phase)).selected?.proof, 'opaque-stored-proof');
      const order = await reader.order({ kind: 'exec', id: 'test-holder' }, phase);
      assert.equal(order.response.text, 'full projection');
      assert.ok(order.response.order?.consumesProofRelay);
    }
    assert.equal(observed.length, 6);
    available = false;
    await assert.rejects(reader.structure(selection, 'prestart'), /unavailable/);
    assert.equal(observed.length, 7, 'expected refusal never requests a legacy route');
    available = true; mixed = true;
    await assert.rejects(reader.structure(selection, 'prestart'), /refused/);
    assert.equal(observed.length, 8, 'mixed constituent never requests a legacy route');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
