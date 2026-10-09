import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { createHubClient } from '../src/hub/client.ts';
import { createRoutingChildClient } from '../src/hub/routing-child-client.ts';
import type { DecisionBindingV1, OrderPacket, ReferenceRouting } from '../src/hub/types.ts';
import type { RoutedClaimV2, RoutedReferenceV2 } from '../src/hosted/trusted-routed-reference-v2.ts';
import type { RecordedClaimV2, RecordedReferenceV2 } from '../src/hosted/trusted-routed-recorded-v2.ts';
import { createRoutingBroker } from '../src/shift/routing-broker.ts';
import { createDefaultSpawner } from '../src/shift/spawn.ts';
import { finalizeChildReservation, reserveChild, startReservedChild } from '../src/shift/state.ts';

const origin = 'https://hub.example';
const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const credential = `rs1.${sessionId}.${'x'.repeat(43)}`;
const identity = { orgId: 'org', principalId: 'agent', sessionId,
  shiftId: 'shf_service', expiresAt: 90_000 };
const binding: DecisionBindingV1 = { orgId: 'org', runId: 'root', frameId: 'frame',
  def: { bundleDigest: 'sha256:bundle', workflowName: 'routing/child' }, subjectKey: 'subject',
  evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates', policyDigest: 'sha256:policy',
  revisions: { definition: '1', candidates: '1', policy: '1', authority: '1', rolePolicy: '1',
    roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
  issuedAt: 1_000, expiresAt: 80_000, authority: { principalId: 'agent', sessionId } };
const selected = { id: 'tuple_one', harness: 'codex', model: 'model-one', effort: 'medium' } as const;
const routing = { claim: { state: 'claimed', claimId: 'run', decisionId: 'decision', binding,
  invocationId: null, orderId: 'run', attemptId: 'attempt', principalId: 'agent',
  sessionId, shiftId: identity.shiftId },
decision: { decisionId: 'decision', binding, status: 'applied', applied: null, effect: null },
preference: { offer: null, tuples: [{ tuple: selected, eligible: true, available: true }],
  role: 'implementation', rolePolicy: null, rosterRevision: 'a'.repeat(64), expiresAt: 70_000 } } as ReferenceRouting;
const order = { workflow: 'frame', run: 'run', step: 'build', key: '',
  defDigest: 'd'.repeat(64), inputs: [], outputs: ['out'], consumes: {}, consumedFingerprint: {},
  owes: [{ path: 'out', version: 1 }], routing } as unknown as OrderPacket;
const target = { workflow: 'root', run: 'run' };
const wireBinding = { rootWorkflow: 'root', frameWorkflow: 'frame', run: 'run',
  claimId: 'run', decisionId: 'decision', sessionId, shiftId: identity.shiftId,
  orderDigest: 'b'.repeat(64), authorityRevision: 'c'.repeat(64),
  rosterRevision: routing.preference.rosterRevision, routingDigest: valueDigestHex(routing),
  preferenceExpiresAt: routing.preference.expiresAt };

async function waitFor(path: string): Promise<void> {
  for (let index = 0; index < 500; index++) {
    if (existsSync(path)) return;
    await sleep(10);
  }
  throw new Error('agent child did not enter');
}

for (const scenario of ['closed-ask', 'held-release', 'claim-moved',
  'sole-lost-submit', 'mixed-lost-effects', 'release-revoked', 'not-started',
  'quiesce-session-revoked', 'sole-lost-holder-submit', 'receipt-pending',
  'receipt-held', 'receipt-unavailable', 'receipt-revoked'] as const) test(
  `retained agent socket binds frozen outcome and targeted release (${scenario})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-agent-outcome-'));
  const permit = join(root, 'permit'), entered = join(root, 'entered');
  const script = join(root, 'role.mjs');
  writeFileSync(script, `import { existsSync } from 'node:fs';\n`
    + `import { readFile, writeFile } from 'node:fs/promises';\n`
    + `import { setTimeout as sleep } from 'node:timers/promises';\n`
    + `for (;;) { try { if ((await readFile(process.env.OWENLOOP_START_GATE,'utf8')).trim()==='start') break; } catch {} await sleep(5); }\n`
    + `const h=JSON.parse(await readFile(process.env.OWENLOOP_ROUTING_HANDOFF,'utf8'));\n`
    + `while (!existsSync(${JSON.stringify(permit)})) await sleep(5);\n`
    + `process.once('message',async m=>{await writeFile(${JSON.stringify(entered)},String(m?.type==='routing-gate-entry-allowed'));if(process.connected)process.disconnect();});\n`
    + `process.send({type:'routing-gate-entered',dispatchToken:h.reservation.token,routingHandoff:process.env.OWENLOOP_ROUTING_HANDOFF});\n`
    + `setInterval(()=>{},1000);\n`);
  let closed = false, releases = 0, asks = 0, submits = 0, receipts = 0, reportDigest = '';
  const lostSubmit = scenario === 'sole-lost-submit' || scenario === 'mixed-lost-effects'
    || scenario === 'sole-lost-holder-submit' || scenario.startsWith('receipt-');
  const receiptUncertain = scenario === 'receipt-unavailable' || scenario === 'receipt-revoked';
  let currentIdentity: typeof identity | undefined = identity;
  let releaseStarted!: () => void, resolveRelease!: () => void;
  const startedRelease = new Promise<void>(resolve => { releaseStarted = resolve; });
  const releaseGate = new Promise<void>(resolve => { resolveRelease = resolve; });
  let approvalStarted!: () => void, resolveApproval!: () => void;
  const startedApproval = new Promise<void>(resolve => { approvalStarted = resolve; });
  const approvalGate = new Promise<void>(resolve => { resolveApproval = resolve; });
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      if (route === 'get_order') return Response.json({ text: 'ok', workflow: 'frame', run: 'run',
	lease: { claimed: !closed }, order: closed ? null : order });
      if (route === 'read_routing_claim') return Response.json({ routing,
	freshness: 'fresh-at-read', atomicLaunch: false });
      if (route === 'reserve_launch') return Response.json({ reservationId: 'lr_one',
	orderId: 'run', expiresAt: 65_000 });
      if (route === 'report_launch') {
	reportDigest = valueDigestHex(JSON.parse(String(init!.body)).report);
	return Response.json({ orderId: 'run', digest: reportDigest, recordedAt: 2_000,
	  provenance: 'authenticated-worker-report' });
      }
      if (route === 'routing_ask/v1') { asks++;
	if (scenario === 'mixed-lost-effects') throw new Error('lost ask ACK');
	closed = true;
	return Response.json({ text: 'asked', ok: true, closed: true }); }
      if (route === 'routing_submit_conditional/v1') {
	submits++; closed = scenario !== 'receipt-held'; throw new Error('lost conditional ACK');
      }
      if (route === 'routing_submit_conditional_receipt/v1') {
	receipts++;
	if (scenario === 'receipt-unavailable') return Response.json({ state: 'unavailable' });
	if (scenario === 'receipt-pending' && receipts === 1) return Response.json({ state: 'pending' });
	if (scenario === 'receipt-revoked') currentIdentity = undefined;
	return Response.json({ state: 'committed', result: { text: 'accepted',
	  outcome: 'submitted', closed: scenario !== 'receipt-held',
	  conditionApplied: 'routed-conditional-receipt-v1' } });
      }
      if (route === 'routing_submit_conditional_receipt_revoke/v1')
	return Response.json({ revoked: true });
      if (route === 'routing_request_approval/v1') {
	approvalStarted(); await approvalGate;
	return Response.json({ ok: true, text: 'approved' });
      }
      if (route === 'release') { releases++;
	if (scenario === 'release-revoked') { releaseStarted(); await releaseGate; }
	closed = true;
	return Response.json({ released: true }); }
      throw new Error(`unexpected route ${route}`);
    }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  const reserved = reserveChild(root, { ...target, childKind: 'agent-run', reservedAt: 1_000 });
  const handoffPath = join(root, 'handoff.json');
  const handoff = { version: 'routing-handoff-v1' as const, incarnation: `inc_${'a'.repeat(32)}`,
    nonce: 'b'.repeat(32), origin, orgId: 'org', sessionId, shiftId: identity.shiftId,
    broker: { socketPath: broker.socketPath, cap: '' }, reservation: reserved.reservation,
    createdAt: 1_000, expiresAt: 70_000, sessionExpiresAt: 90_000 };
  const reference: RoutedReferenceV2 = { protocol: 'trusted-routed-reference-read-v2',
    state: 'available', ...target, order, inputs: [], lease: { claimed: true },
    binding: wireBinding };
  const claim: RoutedClaimV2 = { protocol: 'routing-claim-read-v2',
    state: 'available', ...target, routing, binding: wireBinding };
  const recordedBinding = () => ({ ...wireBinding, recordedOccurrence: {
    reservationId: 'lr_one', reportDigest, recordedAt: 2_000, attemptId: 'attempt' } });
  const recordedReference = (): RecordedReferenceV2 => ({
    ...reference, protocol: 'trusted-routed-recorded-reference-read-v2',
    binding: recordedBinding() });
  const recordedClaim = (): RecordedClaimV2 => ({
    ...claim, protocol: 'routing-recorded-claim-read-v2', binding: recordedBinding() });
  const grant = broker.issue({ reservation: reserved.reservation, routing, identity,
    currentIdentity: () => currentIdentity, hub,
    routedV2Read: async kind => kind === 'reference' ? reference : claim,
    routedLiveV2Read: async kind => kind === 'reference' ? recordedReference() : recordedClaim(),
    inputAuthority: { observe: async (_response, phase) => phase === 'prestart'
      ? { reference, claim } : { reference: recordedReference(), claim: recordedClaim() } },
    submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => true,
      sign: async () => 'proof' },
    launchAuthority: { verifySelection: async () => {} } });
  const pristineDiagnostics = grant.diagnosticsSnapshot();
  assert.equal(Object.isFrozen(pristineDiagnostics), true);
  assert.equal(pristineDiagnostics.agentOutcomeAccepted, 0);
  handoff.broker.cap = grant.cap;
  writeFileSync(handoffPath, JSON.stringify(handoff));
  const client = createRoutingChildClient(handoff);
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const spawner = createDefaultSpawner(origin, 'default', script, identity.shiftId,
    undefined, undefined, undefined, () => exited());
  let record: ReturnType<typeof finalizeChildReservation> | undefined;
  let phase = 'gate';
  const spawned = spawner({ ...target, kind: 'agent-run', startGate: reserved.gatePath,
    routingHandoff: handoffPath, dispatchToken: reserved.reservation.token,
    onGateEntered: entry => {
      if (!record || entry.pid !== record.pid || entry.dispatchToken !== reserved.reservation.token
	|| entry.routingHandoff !== handoffPath) throw new Error('wrong child entry');
      grant.markChildEntered(record);
    },
    canAllowGateEntry: () => !!record && grant.canAllowEntry(record),
    onTerminal: reason => { if (reason !== 'exit') grant.terminal(); } });
  try {
    record = finalizeChildReservation(root, reserved.reservation,
      { pid: spawned.pid, spawnedAt: 2_000, kind: 'agent-run' });
    grant.activate(record);
    grant.bindChild(record, spawned.custody!, { incarnation: handoff.incarnation, nonce: handoff.nonce });
    assert.equal(startReservedChild(root, record), true);
    grant.markGateSignalled(record);
    spawned.armGateEntry?.();
    const request = { version: 'launch-reservation-v1' as const, claimId: 'run',
      decisionId: 'decision', binding, orderId: 'run', attemptId: 'attempt',
      rosterRevision: routing.preference.rosterRevision, candidateIds: [selected.id],
      assessmentId: null, requested: null, selected };
    if (scenario !== 'not-started') {
      phase = 'reserve';
      await client.reserveLaunch({ workflow: 'root', request });
      phase = 'report';
      await client.reportLaunch({ workflow: 'root', report: { version: 'launch-v1',
	reservationId: 'lr_one', decisionId: 'decision', binding, claimId: 'run',
	orderId: 'run', attemptId: 'attempt', requested: null, selected,
	observation: { state: 'unknown' } } });
    }
    writeFileSync(permit, 'go');
    await waitFor(entered);
    if (scenario === 'not-started') {
      phase = 'not-started';
      assert.deepEqual(await client.quiesce(), { quiescing: true, effects: 'settled' });
      assert.equal((await client.agentFinish({ observation: 'not-started' })).state, 'released');
      assert.equal(releases, 1);
      assert.equal(asks + submits + receipts, 0);
      assert.equal(grant.diagnosticsSnapshot().agentFinishAccepted, 1);
      assert.equal(grant.diagnosticsSnapshot().releaseDispatched, 1);
      return;
    }
    await assert.rejects(client.agentOutcome({ group: {
      scope: 'original-posix-group', state: 'empty' } }), /routing broker unavailable/);
    assert.equal(grant.diagnosticsSnapshot().agentOutcomeAccepted, 0, 'guard refusal is not an accepted outcome');
    const holder = { kind: 'exec' as const, id: `${hostname()}:${record.pid}`,
      shiftId: identity.shiftId };
    phase = 'current-order';
    assert.equal((await client.getOrder({ ...target, holder })).order?.workflow, 'frame');
    if (scenario === 'quiesce-session-revoked') {
      phase = 'paused-quiesce';
      const approval = assert.rejects(client.requestApproval({ ...target, tool_use_id: 'tool-one',
	tool_name: 'write', tool_input: {}, reason: 'current task' }),
	/routing broker unavailable/);
      await startedApproval;
      // Parent freeze flips before the first await, so revocation happens
      // while its in-flight effect drain is still pending.
      const frozen = grant.quiesce();
      const outcome = client.agentOutcome({ group: {
	scope: 'original-posix-group', state: 'empty' } }).then(
	value => ({ kind: 'ok' as const, value }),
	error => ({ kind: 'error' as const, error }));
      await sleep(25);
      currentIdentity = undefined;
      resolveApproval();
      await approval;
      assert.equal((await frozen).effects, 'uncertain');
      const observed = await outcome;
      assert.equal(observed.kind, 'ok', 'the paused read crossed the quiesce await');
      if (observed.kind === 'ok') assert.equal(observed.value.claim, 'uncertain');
      assert.equal(releases, 0);
      assert.equal(grant.diagnosticsSnapshot().agentOutcomeUncertainReturns, 1);
      return;
    }
    if (scenario === 'closed-ask') {
      phase = 'ask';
      assert.equal((await client.ask({ ...target, path: 'out', question: 'Need input?' })).closed, true);
      assert.equal(asks, 1);
    }
    if (scenario === 'mixed-lost-effects') {
      phase = 'lost-ask';
      await assert.rejects(client.ask({ ...target, path: 'out', question: 'Need input?' }),
	/routing broker unavailable/);
    }
    if (lostSubmit) {
      phase = 'lost-submit';
      const submitClient = scenario === 'sole-lost-holder-submit'
	? createRoutingChildClient({ ...handoff, broker: grant.holder! }) : client;
      const submitHolder = scenario === 'sole-lost-holder-submit'
	? { kind: 'session' as const, id: sessionId, shiftId: identity.shiftId } : holder;
      await assert.rejects(submitClient.submit({ ...target, path: 'out', value: { ok: true }, holder: submitHolder }),
	/routing broker unavailable/);
      assert.equal(submits, 1);
    }
    phase = 'quiesce';
    assert.deepEqual(await client.quiesce(), { quiescing: true,
      effects: lostSubmit ? 'uncertain' : 'settled' });
    phase = 'outcome';
    assert.equal((await client.agentOutcome({ group: {
      scope: 'original-posix-group', state: 'empty' } })).claim,
      scenario === 'closed-ask' || lostSubmit && scenario !== 'mixed-lost-effects'
	&& scenario !== 'receipt-held' && !receiptUncertain ? 'closed'
	: scenario === 'mixed-lost-effects' || receiptUncertain ? 'uncertain' : 'held');
    const recovered = grant.diagnosticsSnapshot();
    assert.equal(recovered.quiesceAccepted, 1);
    assert.equal(recovered.agentOutcomeAccepted, 1);
    assert.equal(recovered.pendingSubmitReceiptReads, 0);
    assert.equal(recovered.terminalReceiptReads, 0);
    assert.equal(recovered.retryIssuesDispatched + recovered.replayConditionalMutationsDispatched, 0);
    assert.equal(recovered.initialConditionalMutationsDispatched, lostSubmit ? 1 : 0);
    assert.equal(recovered.holderSubmitsAccepted, scenario === 'sole-lost-holder-submit' ? 1 : 0);
    assert.equal(recovered.roleSubmitsAccepted, lostSubmit && scenario !== 'sole-lost-holder-submit' ? 1 : 0);
    assert.equal(recovered.agentOutcomeRecoveryEntries, lostSubmit && scenario !== 'mixed-lost-effects' ? 1 : 0);
    assert.equal(recovered.agentOutcomeReceiptReads, receipts);
    const exactClosedRecovery = lostSubmit && scenario !== 'mixed-lost-effects'
      && scenario !== 'receipt-held' && !receiptUncertain;
    assert.equal(recovered.agentOutcomeCommittedClosedReceipts, exactClosedRecovery ? 1 : 0);
    assert.equal(recovered.agentOutcomeRecoveredClosedSubmits, exactClosedRecovery ? 1 : 0);
    assert.equal(recovered.agentOutcomeClosedReturns, exactClosedRecovery || scenario === 'closed-ask' ? 1 : 0);
    assert.equal(recovered.agentOutcomeUncertainReturns, receiptUncertain || scenario === 'mixed-lost-effects' ? 1 : 0);
    assert.equal(recovered.agentOutcomeHeldReturns, recovered.agentOutcomeClosedReturns + recovered.agentOutcomeUncertainReturns ? 0 : 1);
    assert.equal(recovered.overflow || recovered.incomplete, false);
    assert.equal(pristineDiagnostics.agentOutcomeAccepted, 0, 'old immutable snapshot is not a live view');
    if (receiptUncertain) { assert.equal(releases, 0); return; }
    if (scenario === 'claim-moved') closed = true;
    phase = 'finish';
    const finish = client.agentFinish({ group: {
      scope: 'original-posix-group', state: 'empty' } });
    if (scenario === 'release-revoked') {
      await startedRelease;
      currentIdentity = undefined;
      resolveRelease();
    }
    assert.equal((await finish).state,
      scenario === 'closed-ask' || exactClosedRecovery ? 'already-closed'
	: scenario === 'held-release' || scenario === 'receipt-held' ? 'released' : 'uncertain');
    assert.equal(releases, scenario === 'held-release' || scenario === 'release-revoked' || scenario === 'receipt-held' ? 1 : 0);
    assert.equal(receipts, exactClosedRecovery || scenario === 'receipt-held' ? scenario === 'receipt-pending' ? 2 : 1 : 0,
      'an unrelated lost holder effect prevents even exact conditional receipt reconciliation');
    assert.equal(grant.diagnosticsSnapshot().agentFinishAccepted, 1);
    assert.equal(grant.diagnosticsSnapshot().releaseDispatched, releases);
    const beforeHolderRefusal = grant.diagnosticsSnapshot();
    const { createConnection } = await import('node:net');
    for (const method of ['agent_outcome', 'agent_finish']) {
      const holderAnswer = await new Promise<Record<string, unknown>>((resolve, reject) => {
	const socket = createConnection(broker.socketPath); let raw = '';
	socket.once('connect', () => socket.write(JSON.stringify({ cap: grant.holder!.cap,
	  method, body: { group: {
	    scope: 'original-posix-group', state: 'empty' } } }) + '\n'));
	socket.on('data', chunk => { raw += chunk.toString(); if (raw.includes('\n')) {
	  socket.destroy(); resolve(JSON.parse(raw.slice(0, raw.indexOf('\n'))) as Record<string, unknown>);
	} });
	socket.once('error', reject);
      });
      assert.equal(holderAnswer.ok, false, `${method} is role-only`);
    }
    assert.deepEqual(grant.diagnosticsSnapshot(), beforeHolderRefusal);
  } catch (error) {
    throw new Error(`agent socket phase ${phase}`, { cause: error });
  } finally {
    spawned.cancel?.();
    await Promise.race([exit, sleep(5_000)]);
    if (scenario === 'mixed-lost-effects' || scenario === 'release-revoked'
      || scenario === 'quiesce-session-revoked' || receiptUncertain)
      await assert.rejects(broker.close(), /routing effect outcome quarantined/);
    else await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
