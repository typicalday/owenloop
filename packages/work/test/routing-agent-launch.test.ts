import assert from 'node:assert/strict';
import { test } from 'node:test';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { createRoutedAgentPrestart, createRoutedAgentSelection } from '../src/roles/routing-agent-launch.ts';
import type { RoutingChildClient } from '../src/hub/routing-child-client.ts';
import type { DecisionBindingV1, LaunchReportV1, LocalModelAssessment,
  LocalModelTuple, OrderPacket, ReferenceRouting } from '../src/hub/types.ts';

const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const binding: DecisionBindingV1 = { orgId: 'org', runId: 'wf', frameId: 'frame',
  def: { bundleDigest: 'sha256:bundle', workflowName: 'wf' }, subjectKey: 'subject',
  evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates', policyDigest: 'sha256:policy',
  revisions: { definition: '1', candidates: '1', policy: '1', authority: '1', rolePolicy: '1',
    roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
  issuedAt: 1_000, expiresAt: 80_000, authority: { principalId: 'agent', sessionId } };
const first: LocalModelTuple = { id: 'first', harness: 'codex', model: 'm1', effort: 'medium' };
const second: LocalModelTuple = { id: 'second', harness: 'claude', model: 'm2', effort: 'high' };
const routing: ReferenceRouting = { claim: { state: 'claimed', claimId: 'run', decisionId: 'decision',
  binding, invocationId: null, orderId: 'run', attemptId: 'attempt', principalId: 'agent',
  sessionId, shiftId: 'shf_service' },
  decision: { decisionId: 'decision', binding, status: 'applied', applied: null, effect: null },
  preference: { offer: null, tuples: [{ tuple: first, eligible: true, available: true },
    { tuple: second, eligible: true, available: true }], role: 'implementation', rolePolicy: null,
    rosterRevision: 'roster-v1', expiresAt: 70_000 } };
const order: OrderPacket = { workflow: 'wf', run: 'run', step: 'build', key: '',
  defDigest: 'a'.repeat(64), worker: 'agent', inputs: [], outputs: ['out'], consumes: {}, routing,
  owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] };
const holder = { kind: 'session' as const, id: sessionId, shiftId: 'shf_service' };

function fixture(packet = order) {
  const calls: string[] = [];
  let report: LaunchReportV1 | undefined;
  const child = {
    readRoutingClaim: async () => { calls.push('claim'); return {
      routing: packet.routing, freshness: 'fresh-at-read', atomicLaunch: false }; },
    assessLocalModel: async () => { calls.push('assess'); throw new Error('unexpected assessment'); },
    reserveLaunch: async ({ request }: { request: unknown }) => {
      calls.push('reserve'); assert.deepEqual(request, { version: 'launch-reservation-v1',
	claimId: 'run', decisionId: 'decision', binding, orderId: 'run', attemptId: 'attempt',
	rosterRevision: 'roster-v1', candidateIds: ['first', 'second'], assessmentId: null,
	requested: null, selected: first });
      return { reservationId: 'lr-one', orderId: 'run', expiresAt: 50_000 };
    },
    reportLaunch: async ({ report: sent }: { report: LaunchReportV1 }) => {
      calls.push('report'); report = sent;
      return { orderId: 'run', digest: valueDigestHex(sent), recordedAt: 2_000,
	provenance: 'authenticated-worker-report' as const };
    },
    getLaunchOrder: async () => { calls.push('order'); return { workflow: 'wf', run: 'run', text: '',
      lease: { claimed: true }, order: packet }; },
  } as unknown as RoutingChildClient;
  return { child, calls, report: () => report };
}

test('agent launch reserves the first Service-ordered tuple and awaits unknown receipt and final order', async () => {
  const f = fixture();
  const prestart = createRoutedAgentPrestart({ child: f.child, holder,
    workflow: 'wf', run: 'run', now: () => 2_000 });
  const selected = await prestart(order);
  assert.deepEqual(selected, { selected: first, reservationId: 'lr-one', expiresAt: 50_000 });
  assert.deepEqual(f.calls, ['claim', 'reserve', 'report', 'order']);
  assert.deepEqual(f.report()?.observation, { state: 'unknown' });
  await assert.rejects(prestart(order), /routed agent launch refused/);
  assert.deepEqual(f.calls, ['claim', 'reserve', 'report', 'order']);
});

test('agent selection defers reserve and report until local adapter preflight has passed', async () => {
  const f = fixture();
  const select = createRoutedAgentSelection({ child: f.child, holder,
    workflow: 'wf', run: 'run', now: () => 2_000 });
  const plan = await select(order);
  assert.deepEqual(plan.selected, first);
  assert.deepEqual(f.calls, ['claim']);
  await plan.authorize();
  assert.deepEqual(f.calls, ['claim', 'reserve', 'report', 'order']);
  await assert.rejects(plan.authorize(), /routed agent launch refused/);
  await assert.rejects(select(order), /routed agent launch refused/);
});

test('agent selection aborts during local preflight without reserving or reporting', async () => {
  const f = fixture();
  const controller = new AbortController();
  const plan = await createRoutedAgentSelection({ child: f.child, holder,
    workflow: 'wf', run: 'run', now: () => 2_000 })(order, controller.signal);
  controller.abort();
  await assert.rejects(plan.authorize(), /routed agent launch refused/);
  assert.deepEqual(f.calls, ['claim']);
});

function assessment(status: 'advisory' | 'fallback', advised: LocalModelTuple | null): LocalModelAssessment {
  return { version: 'local-model-assessment-v1', assessmentId: 'lma-one', workflow: 'wf',
    frameId: 'frame', definition: binding.def, decisionId: 'decision', claimId: 'run',
    orderId: 'run', attemptId: 'attempt', anchorDigest: 'sha256:anchor',
    candidateIds: ['first', 'second'], candidateDigest: 'sha256:candidates',
    policy: { id: 'p', revision: '1', digest: 'sha256:policy', onFailure: 'fallback' },
    createdAt: 1_000, expiresAt: 60_000, status, reason: status,
    advised, provider: null };
}

for (const status of ['advisory', 'fallback'] as const) {
  test(`agent ${status} assessment binds the exact requested and selected tuple`, async () => {
    const packet = structuredClone(order);
    packet.routing!.preference.localModel = { version: 'local-model-policy-v1', onFailure: 'fallback' };
    const f = fixture(packet);
    const advised = status === 'advisory' ? second : null;
    f.child.assessLocalModel = async ({ candidateIds }) => {
      f.calls.push('assess'); assert.deepEqual(candidateIds, ['first', 'second']);
      return { status, reason: status, assessment: assessment(status, advised) };
    };
    f.child.reserveLaunch = async ({ request }) => {
      f.calls.push('reserve'); assert.equal(request.assessmentId, 'lma-one');
      assert.deepEqual(request.requested, advised);
      assert.deepEqual(request.selected, status === 'advisory' ? second : first);
      return { reservationId: 'lr-one', orderId: 'run', expiresAt: 50_000 };
    };
    const selected = await createRoutedAgentPrestart({ child: f.child, holder,
      workflow: 'wf', run: 'run', now: () => 2_000 })(packet);
    assert.deepEqual(selected.selected, status === 'advisory' ? second : first);
    assert.deepEqual(f.calls, ['claim', 'assess', 'reserve', 'report', 'order']);
  });
}

test('agent assessment refuses an invented preference tuple before reservation', async () => {
  const packet = structuredClone(order);
  packet.routing!.preference.localModel = { version: 'local-model-policy-v1', onFailure: 'fallback' };
  const f = fixture(packet);
  f.child.assessLocalModel = async () => { f.calls.push('assess'); return {
    status: 'advisory', reason: 'ok', assessment: assessment('advisory',
      { ...second, id: 'invented' }) }; };
  await assert.rejects(createRoutedAgentPrestart({ child: f.child, holder,
    workflow: 'wf', run: 'run', now: () => 2_000 })(packet), /routed agent launch refused/);
  assert.deepEqual(f.calls, ['claim', 'assess']);
});

test('agent launch refuses a lost report acknowledgment and never authorizes final provider gate', async () => {
  const f = fixture();
  f.child.reportLaunch = async () => { f.calls.push('report'); return { orderId: 'run',
    digest: 'wrong', recordedAt: 2_000, provenance: 'authenticated-worker-report' }; };
  await assert.rejects(createRoutedAgentPrestart({ child: f.child, holder,
    workflow: 'wf', run: 'run', now: () => 2_000 })(order), /routed agent launch refused/);
  assert.deepEqual(f.calls, ['claim', 'reserve', 'report']);
});

test('agent launch refuses stop during assessment without reserve or report', async () => {
  const packet = structuredClone(order);
  packet.routing!.preference.localModel = { version: 'local-model-policy-v1', onFailure: 'fallback' };
  const f = fixture(packet);
  const controller = new AbortController();
  f.child.assessLocalModel = async () => { f.calls.push('assess'); controller.abort();
    return { status: 'advisory', reason: 'ok', assessment: assessment('advisory', second) }; };
  await assert.rejects(createRoutedAgentPrestart({ child: f.child, holder,
    workflow: 'wf', run: 'run', now: () => 2_000 })(packet, controller.signal), /routed agent launch refused/);
  assert.deepEqual(f.calls, ['claim', 'assess']);
});
