import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoutedLaunchAuthority } from '../src/shift/routing-launch-authority.ts';
import type { DecisionBindingV1, LaunchReservationRequestV1, OrderPacket,
  ReferenceRouting, RoutingOfferCandidate, ShiftOffer, WorkOrder } from '../src/hub/types.ts';

const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const binding: DecisionBindingV1 = { orgId: 'org', runId: 'wf', frameId: 'frame',
  def: { bundleDigest: 'sha256:bundle', workflowName: 'wf' }, subjectKey: 'subject',
  evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates', policyDigest: 'sha256:policy',
  revisions: { definition: '1', candidates: '1', policy: '1', authority: '1', rolePolicy: '1',
    roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
  issuedAt: 1_000, expiresAt: 80_000, authority: { principalId: 'agent', sessionId } };
const tupleA = { id: 'a', harness: 'codex', model: 'alpha', effort: 'high' as const };
const tupleB = { id: 'b', harness: 'codex', model: 'beta', effort: 'high' as const };
const tuples = [{ tuple: tupleA, eligible: true, available: true },
  { tuple: tupleB, eligible: true, available: true }];
const policy = { revision: 'policy', unknownRole: 'refuse' as const,
  rules: [{ model: 'alpha', roles: ['implementation' as const] },
    { model: 'beta', roles: ['implementation' as const] }] };
const candidate: RoutingOfferCandidate = { candidateId: 'candidate', frameId: 'frame', step: 'build', key: '',
  evidenceGeneration: 'one', context: { now: 1_000, maxTtlMs: 120_000, orgId: 'org',
    principalId: 'agent', sessionId, shiftId: 'shf_shift', rosterRevision: 'roster',
    rolePolicyRevision: 'policy', runId: 'wf', crewId: 'crew', capability: 'build' },
  role: 'implementation', rolePolicy: policy, tuples };
const offer: ShiftOffer = { version: 'shift-offer-v1', offerId: 'of_one', orgId: 'org',
  principalId: 'agent', sessionId, shiftId: 'shf_shift',
  willingness: { runIds: ['wf'], crewIds: ['crew'], capabilities: ['build'] },
  rosterRevision: 'roster', rolePolicyRevision: 'policy', tuples,
  issuedAt: 1_000, expiresAt: 50_000 };
const routing: ReferenceRouting = { claim: { state: 'claimed', claimId: 'claim',
  decisionId: 'decision', binding, invocationId: null, orderId: 'run', attemptId: 'attempt',
  principalId: 'agent', sessionId, shiftId: 'shf_shift' },
  decision: { decisionId: 'decision', binding, status: 'applied', applied: null, effect: null },
  preference: { offer, tuples, role: 'implementation', rolePolicy: policy,
    rosterRevision: 'roster', expiresAt: 50_000 } };
const offered: WorkOrder = { workflow: 'wf', run: 'run', step: 'build', worker: 'agent',
  defDigest: 'a'.repeat(64), consumes: {}, expected_outputs: [], feedback: [], advisory: {},
  submit_hint: '', routing };
const order: OrderPacket = { workflow: 'wf', run: 'run', step: 'build', key: '', worker: 'agent',
  defDigest: offered.defDigest!, inputs: [], outputs: ['out'], consumes: {},
  owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }], routing };
const request: LaunchReservationRequestV1 = { version: 'launch-reservation-v1', claimId: 'claim',
  decisionId: 'decision', binding, orderId: 'run', attemptId: 'attempt',
  rosterRevision: 'roster', candidateIds: ['a', 'b'], assessmentId: null,
  requested: null, selected: tupleA };

test('parent launch authority refuses changed or reordered machine roster before reserve/report', async () => {
  let snapshot = 'ordered-a-b';
  let current = tuples;
  const authority = createRoutedLaunchAuthority({ offered,
    offer: { candidate, offer, rosterSnapshot: snapshot },
    currentTuples: () => current, currentRosterSnapshot: () => snapshot });
  await authority.verifySelection(order, request);
  snapshot = 'ordered-b-a';
  await assert.rejects(authority.verifySelection(order, request), /selection refused/);
  snapshot = 'ordered-a-b';
  current = [tuples[1]!, tuples[0]!];
  await assert.rejects(authority.verifySelection(order, request), /selection refused/);
  current = tuples;
  await assert.rejects(authority.verifySelection(order, { ...request, candidateIds: ['b', 'a'] }),
    /selection refused/);
});

test('command launch authority accepts only the empty null tuple', async () => {
  const commandRouting: ReferenceRouting = { ...routing, preference: { ...routing.preference,
    offer: null, tuples: [] } };
  const commandOffered = { ...offered, worker: 'command', routing: commandRouting };
  const commandOrder = { ...order, worker: 'command', routing: commandRouting };
  const authority = createRoutedLaunchAuthority({ offered: commandOffered,
    currentTuples: () => [], currentRosterSnapshot: () => undefined });
  await authority.verifySelection(commandOrder, { ...request, candidateIds: [], selected: null });
  await assert.rejects(authority.verifySelection(commandOrder, request), /selection refused/);
});
