import assert from 'node:assert/strict';
import { test } from 'node:test';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { createRoutedCommandPrestart } from '../src/roles/routing-command-launch.ts';
import type { RoutingChildClient } from '../src/hub/routing-child-client.ts';
import type { DecisionBindingV1, LaunchReportV1, OrderPacket, ReferenceRouting } from '../src/hub/types.ts';
import type { RoutedInputAdmission } from '../src/hosted/trusted-input-admission.ts';

const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const binding: DecisionBindingV1 = { orgId: 'org', runId: 'wf', frameId: 'frame',
  def: { bundleDigest: 'sha256:bundle', workflowName: 'wf' }, subjectKey: 'subject',
  evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates', policyDigest: 'sha256:policy',
  revisions: { definition: '1', candidates: '1', policy: '1', authority: '1', rolePolicy: '1',
    roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
  issuedAt: 1_000, expiresAt: 80_000, authority: { principalId: 'agent', sessionId } };
const routing: ReferenceRouting = { claim: { state: 'claimed', claimId: 'claim', decisionId: 'decision',
  binding, invocationId: null, orderId: 'run', attemptId: 'attempt', principalId: 'agent',
  sessionId, shiftId: 'shf_service' },
  decision: { decisionId: 'decision', binding, status: 'applied', applied: null, effect: null },
  preference: { offer: null, tuples: [], role: 'implementation', rolePolicy: null,
    rosterRevision: 'roster-v1', expiresAt: 70_000 } };
const order: OrderPacket = { workflow: 'frame', run: 'run', step: 'build', key: '', defDigest: 'a'.repeat(64),
  worker: 'command', inputs: [], outputs: ['out'], consumes: {}, routing,
  owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] };
const holder = { kind: 'exec' as const, id: 'host:1', shiftId: 'shf_service' };

test('command launch awaits empty-tuple reserve, exact unknown report, and final order read', async () => {
  const calls: string[] = [];
  let sent: LaunchReportV1 | undefined;
  const child = {
    readRoutingClaim: async () => { calls.push('claim'); return { routing, freshness: 'fresh-at-read', atomicLaunch: false }; },
    reserveLaunch: async ({ request }: { request: unknown }) => {
      calls.push('reserve');
      assert.deepEqual(request, { version: 'launch-reservation-v1', claimId: 'claim', decisionId: 'decision',
	binding, orderId: 'run', attemptId: 'attempt', rosterRevision: 'roster-v1',
	candidateIds: [], assessmentId: null, requested: null, selected: null });
      return { reservationId: 'lr-one', orderId: 'run', expiresAt: 50_000 };
    },
    reportLaunch: async ({ report }: { report: LaunchReportV1 }) => {
      calls.push('report'); sent = report;
      return { orderId: 'run', digest: valueDigestHex(report), recordedAt: 2_000,
	provenance: 'authenticated-worker-report' as const };
    },
    getLaunchOrder: async () => { calls.push('order'); return { workflow: 'wf', run: 'run', text: '',
      lease: { claimed: true }, order }; },
  } as unknown as RoutingChildClient;
  const prestart = createRoutedCommandPrestart({ child, holder, workflow: 'wf', frameId: 'frame', run: 'run', now: () => 2_000,
    beforeFinalCheck: () => { calls.push('workdir'); },
    prepareFiles: async () => { calls.push('files'); return { envValue: '[]',
      cleanup: async () => { calls.push('cleanup'); } }; } });
  const prepared = await prestart(order);
  assert.deepEqual(calls, ['claim', 'files', 'reserve', 'report', 'workdir', 'order']);
  assert.deepEqual(sent?.observation, { state: 'unknown' });
  assert.equal(prepared?.consumedFilePathsJson, '[]');
  await prepared?.cleanup();
  await assert.rejects(prestart(order), /routed command launch refused/);
  assert.deepEqual(calls, ['claim', 'files', 'reserve', 'report', 'workdir', 'order', 'cleanup']);
});

test('post-report local workdir refusal prevents final order and physical start', async () => {
  const calls: string[] = [];
  const child = {
    readRoutingClaim: async () => { calls.push('claim'); return { routing, freshness: 'fresh-at-read', atomicLaunch: false }; },
    reserveLaunch: async () => { calls.push('reserve'); return { reservationId: 'lr-one', orderId: 'run', expiresAt: 50_000 }; },
    reportLaunch: async ({ report }: { report: LaunchReportV1 }) => { calls.push('report'); return {
      orderId: 'run', digest: valueDigestHex(report), recordedAt: 2_000,
      provenance: 'authenticated-worker-report' as const }; },
    getLaunchOrder: async () => { calls.push('order'); throw new Error('must not read'); },
  } as unknown as RoutingChildClient;
  await assert.rejects(createRoutedCommandPrestart({ child, holder, workflow: 'wf', frameId: 'frame', run: 'run',
    now: () => 2_000, beforeFinalCheck: () => { calls.push('workdir'); throw new Error('unsafe workdir'); },
    prepareFiles: async () => { calls.push('files'); return { envValue: '[]',
      cleanup: async () => { calls.push('cleanup'); } }; } })(order), /unsafe workdir/);
  assert.deepEqual(calls, ['claim', 'files', 'reserve', 'report', 'workdir', 'cleanup']);
});

test('command launch refuses a malformed report before any final-order read', async () => {
  const calls: string[] = [];
  const child = {
    readRoutingClaim: async () => { calls.push('claim'); return { routing, freshness: 'fresh-at-read', atomicLaunch: false }; },
    reserveLaunch: async () => { calls.push('reserve'); return { reservationId: 'lr-one', orderId: 'run', expiresAt: 50_000 }; },
    reportLaunch: async () => { calls.push('report'); return { orderId: 'run', digest: 'wrong',
      recordedAt: 2_000, provenance: 'authenticated-worker-report' }; },
    getLaunchOrder: async () => { calls.push('order'); throw new Error('must not read'); },
  } as unknown as RoutingChildClient;
  await assert.rejects(createRoutedCommandPrestart({ child, holder, workflow: 'wf', frameId: 'frame', run: 'run',
    now: () => 2_000, prepareFiles: async () => { calls.push('files'); return { envValue: '[]',
      cleanup: async () => { calls.push('cleanup'); } }; } })(order), /routed command launch refused/);
  assert.deepEqual(calls, ['claim', 'files', 'reserve', 'report', 'cleanup']);
});

test('command launch refuses absent file preflight before reserve', async () => {
  const calls: string[] = [];
  const child = { readRoutingClaim: async () => { calls.push('claim'); return {
    routing, freshness: 'fresh-at-read', atomicLaunch: false }; },
    reserveLaunch: async () => { calls.push('reserve'); throw new Error('must not reserve'); },
  } as unknown as RoutingChildClient;
  await assert.rejects(createRoutedCommandPrestart({ child, holder, workflow: 'wf', frameId: 'frame', run: 'run',
    now: () => 2_000 })(order), /routed command launch refused/);
  assert.deepEqual(calls, ['claim']);
});

test('command launch aborts a pending consumed-file download before reserve', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const child = { readRoutingClaim: async () => { calls.push('claim'); return {
    routing, freshness: 'fresh-at-read', atomicLaunch: false }; },
    reserveLaunch: async () => { calls.push('reserve'); throw new Error('must not reserve'); },
  } as unknown as RoutingChildClient;
  const prestart = createRoutedCommandPrestart({ child, holder, workflow: 'wf', frameId: 'frame', run: 'run',
    now: () => 2_000, prepareFiles: async (_order, signal) => {
      calls.push('files'); entered();
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
      calls.push('cleanup');
      throw new Error('download aborted');
    } });
  const result = prestart(order, controller.signal);
  await pending;
  controller.abort();
  await assert.rejects(result, /download aborted/);
  assert.deepEqual(calls, ['claim', 'files', 'cleanup']);
});

test('command launch reobserves the same prestart input witness after file preparation', async () => {
  const calls: string[] = [];
  let reads = 0;
  const child = { readRoutingClaim: async () => { calls.push('claim'); return {
    routing, freshness: 'fresh-at-read', atomicLaunch: false }; },
  reserveLaunch: async () => { calls.push('reserve'); throw new Error('must not reserve'); },
  } as unknown as RoutingChildClient;
  const admission = { observe: async () => {
    reads++;
    return (reads === 1 ? { ok: true, phase: 'prestart', packetDigest: 'packet',
      witnessDigest: 'witness', bindingDigest: 'binding' }
      : { ok: false, reason: 'witness-value-mismatch' }) as RoutedInputAdmission;
  } };
  await assert.rejects(createRoutedCommandPrestart({ child, holder, workflow: 'wf', frameId: 'frame', run: 'run',
    now: () => 2_000, inputAdmission: admission,
    prepareFiles: async () => { calls.push('files'); return { envValue: '[]',
      cleanup: async () => { calls.push('cleanup'); } }; } })(order),
  /routed command launch refused/);
  assert.deepEqual(calls, ['claim', 'files', 'cleanup']);
  assert.equal(reads, 2);
});

test('command launch binds parent root and exact child frame before any broker read or shell start', async () => {
  const calls: string[] = [];
  const child = { readRoutingClaim: async () => { calls.push('claim'); throw new Error('must not read'); } } as unknown as RoutingChildClient;
  const wrongFrame = { ...order, workflow: 'sibling-frame' };
  await assert.rejects(createRoutedCommandPrestart({ child, holder, workflow: 'wf', frameId: 'frame',
    run: 'run', now: () => 2_000, prepareFiles: async () => { throw new Error('must not prepare'); } })(wrongFrame),
  /routed command launch refused/);
  const wrongRoot = createRoutedCommandPrestart({ child, holder, workflow: 'other-root', frameId: 'frame',
    run: 'run', now: () => 2_000, prepareFiles: async () => { throw new Error('must not prepare'); } });
  await assert.rejects(wrongRoot(order), /routed command launch refused/);
  assert.deepEqual(calls, []);
});
