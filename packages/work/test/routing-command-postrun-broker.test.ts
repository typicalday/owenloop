import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { buildReceipt } from '../src/exec/receipt.ts';
import { createHubClient } from '../src/hub/client.ts';
import { createRoutingChildClient } from '../src/hub/routing-child-client.ts';
import type { DecisionBindingV1, OrderPacket, ReferenceRouting } from '../src/hub/types.ts';
import { createRoutingBroker } from '../src/shift/routing-broker.ts';
import { createDefaultSpawner } from '../src/shift/spawn.ts';
import { finalizeChildReservation, reserveChild, startReservedChild } from '../src/shift/state.ts';

const origin = 'https://hub.example';
const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const credential = `rs1.${sessionId}.${'x'.repeat(43)}`;
const identity = { orgId: 'org', principalId: 'agent', sessionId,
  shiftId: 'shf_service', expiresAt: 90_000 };
const binding: DecisionBindingV1 = { orgId: 'org', runId: 'wf', frameId: 'frame',
  def: { bundleDigest: 'sha256:bundle', workflowName: 'wf' }, subjectKey: 'subject',
  evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates', policyDigest: 'sha256:policy',
  revisions: { definition: '1', candidates: '1', policy: '1', authority: '1', rolePolicy: '1',
    roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
  issuedAt: 1_000, expiresAt: 80_000, authority: { principalId: 'agent', sessionId } };
const routing = { claim: { state: 'claimed', claimId: 'run', decisionId: 'decision', binding,
  invocationId: null, orderId: 'run', attemptId: 'attempt', principalId: 'agent',
  sessionId, shiftId: identity.shiftId },
decision: { decisionId: 'decision', binding, status: 'applied', applied: null, effect: null },
preference: { offer: null, tuples: [], role: 'implementation', rolePolicy: null,
  rosterRevision: 'a'.repeat(64), expiresAt: 70_000 } } as ReferenceRouting;
const order = { workflow: 'frame', run: 'run', step: 'build', key: '',
  defDigest: 'd'.repeat(64), worker: 'command', inputs: [], outputs: ['out'],
  consumes: {}, consumedFingerprint: {}, owes: [{ path: 'out', version: 1 }],
  routing } as unknown as OrderPacket;
const referenceBinding = { rootWorkflow: 'wf', frameWorkflow: 'frame', run: 'run',
  claimId: 'run', decisionId: 'decision', sessionId, shiftId: identity.shiftId,
  orderDigest: 'b'.repeat(64), authorityRevision: 'c'.repeat(64),
  rosterRevision: routing.preference.rosterRevision, routingDigest: valueDigestHex(routing),
  preferenceExpiresAt: routing.preference.expiresAt };

async function waitFor(path: string): Promise<void> {
  for (let index = 0; index < 500; index++) {
    if (existsSync(path)) return;
    await sleep(10);
  }
  throw new Error('routed child did not enter');
}

for (const scenario of ['normal', 'submit-held', 'drift-after-sign', 'lost-submit-ack', 'schema-rejected',
  'born-rejected', 'no-start',
  'ask-closed', 'ask-lost-ack', 'reject-held', 'reject-closed',
  'reject-lost-ack', 'collection', 'collection-lost-seal-ack', 'multi-output'] as const) test(
  `post-quiesce role data reaches only parent signed conditional submit once (${scenario})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-postrun-'));
  const permit = join(root, 'permit');
  const entered = join(root, 'entered');
  const script = join(root, 'role.mjs');
  writeFileSync(script, `import { existsSync } from 'node:fs';\n`
    + `import { readFile, writeFile } from 'node:fs/promises';\n`
    + `import { setTimeout as sleep } from 'node:timers/promises';\n`
    + `for (;;) { try { if ((await readFile(process.env.OWENLOOP_START_GATE,'utf8')).trim()==='start') break; } catch {} await sleep(5); }\n`
    + `const h=JSON.parse(await readFile(process.env.OWENLOOP_ROUTING_HANDOFF,'utf8'));\n`
    + `while (!existsSync(${JSON.stringify(permit)})) await sleep(5);\n`
    + `process.once('message',async reply=>{await writeFile(${JSON.stringify(entered)},String(reply?.type==='routing-gate-entry-allowed'));});\n`
    + `process.send({type:'routing-gate-entered',dispatchToken:h.reservation.token,routingHandoff:process.env.OWENLOOP_ROUTING_HANDOFF});\n`
    + `setInterval(()=>{},1000);\n`);
  let closed = false;
  let signs = 0;
  let submits = 0;
  let seals = 0;
  let drift = false;
  const rejection = scenario === 'reject-held' || scenario === 'reject-closed'
    || scenario === 'reject-lost-ack';
  const inputPresent = scenario === 'reject-closed';
  const multiOrder = { ...order, outputs: ['out', 'second'],
    owes: [{ path: 'out', version: 1 }, { path: 'second', version: 1 }] } as unknown as OrderPacket;
  const activeOrder: OrderPacket = rejection ? { ...order, inputs: ['source'],
    consumedFingerprint: { source: 1 }, consumes: inputPresent ? { source: { bad: true } } : {} }
    : scenario === 'collection' || scenario === 'collection-lost-seal-ack'
      ? { ...order, outputs: ['items.sealed'],
      owes: [{ path: 'items.sealed', version: 1 } as OrderPacket['owes'][number]] }
    : scenario === 'multi-output' ? multiOrder : order;
  const witnesses = rejection ? [{ path: 'source', version: 1, present: inputPresent,
    ...(inputPresent ? { value: { bad: true } } : {}) }] : [];
  const requests: Array<{ route: string; body: unknown; rawBody: string;
    session: string | null; intent: string | null }> = [];
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      const rawBody = init?.body ? String(init.body) : '';
      const body = rawBody ? JSON.parse(rawBody) as unknown : undefined;
      const headers = new Headers(init?.headers);
      requests.push({ route, body, rawBody,
	session: headers.get('X-Owenloop-Routing-Session'),
	intent: headers.get('X-Owenloop-Routing-Intent') });
      if (route === 'get_order') return Response.json({ text: 'ok', workflow: 'frame', run: 'run',
        lease: { claimed: !closed }, order: closed ? null : activeOrder });
      if (route === 'reserve_launch') return Response.json({ reservationId: 'lr_one',
        orderId: 'run', expiresAt: 65_000 });
      if (route === 'report_launch') return Response.json({ orderId: 'run',
        digest: valueDigestHex((body as { report: unknown }).report), recordedAt: 2_000,
        provenance: 'authenticated-worker-report' });
      if (route === 'read_routing_claim') return Response.json({ routing,
        freshness: 'fresh-at-read', atomicLaunch: false });
      if (route === 'release') { closed = true; return Response.json({ released: true }); }
      if (route === 'routing_ask/v1') {
        if (scenario === 'ask-lost-ack') throw new Error('lost ask ACK');
        closed = true; return Response.json({ text: 'asked', ok: true, closed: true });
      }
      if (route === 'routing_reject/v1') {
        if (scenario === 'reject-lost-ack') throw new Error('lost reject ACK');
        closed = scenario === 'reject-closed';
        return Response.json({ text: 'rejected', ok: true, closed });
      }
      if (route === 'routing_collection_member_issue/v1') {
        const request = body as { emissionId: string; sealPath: string; valueDigest: string };
        return Response.json({ emissionId: request.emissionId, sealPath: request.sealPath,
          sealTargetVersion: 1, memberPath: 'items[0]', memberVersion: 1,
          valueDigest: request.valueDigest, conditionApplied: 'routed-collection-member-v1' });
      }
      if (route === 'routing_collection_member_emit/v1') return Response.json({
        outcome: 'emitted', closed: false, conditionApplied: 'routed-collection-member-v1' });
      if (route === 'routing_collection_seal/v1') {
        seals++;
        closed = true;
        if (scenario === 'collection-lost-seal-ack' && seals === 1)
          throw new Error('lost seal ACK');
        return Response.json({
        outcome: 'sealed', closed: true, conditionApplied: 'routed-collection-seal-v1' }); }
      if (route === 'routing_submit_conditional_receipt/v1') {
	assert.ok(scenario === 'lost-submit-ack' || scenario === 'schema-rejected'
	  || scenario === 'born-rejected');
	return Response.json({ state: 'committed', result: scenario === 'lost-submit-ack'
	  ? { text: 'accepted', outcome: 'submitted', closed: true,
	    conditionApplied: 'routed-conditional-receipt-v1' }
	  : scenario === 'born-rejected'
	    ? { text: 'native CAS lost', outcome: 'born-rejected', closed: true,
	      conditionApplied: 'routed-conditional-receipt-v1' }
	  : { text: 'schema refused', outcome: 'schema-rejected', issues: [],
	    conditionApplied: 'routed-conditional-receipt-v1' } });
      }
      if (route === 'routing_submit_conditional_receipt_revoke/v1')
	return Response.json({ revoked: true });
      if (route === 'routing_submit_conditional/v1') {
	submits++;
	closed = scenario !== 'multi-output' && scenario !== 'submit-held' || submits === 2;
	if (scenario === 'lost-submit-ack' && submits === 1) throw new Error('lost ACK');
	if (scenario === 'schema-rejected') { closed = false; throw new Error('lost schema ACK'); }
	if (scenario === 'born-rejected') throw new Error('lost CAS ACK');
	return Response.json({ text: 'accepted', outcome: 'submitted', closed,
	  conditionApplied: 'routed-conditional-receipt-v1' }); }
      if (route === 'routing_session_close') return Response.json({ closed: true });
      throw new Error(`unexpected ${route}`);
    }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  const reserved = reserveChild(root, { workflow: 'wf', run: 'run', childKind: 'exec', reservedAt: 1_000 });
  const handoffPath = join(root, 'handoff.json');
  const handoff = { version: 'routing-handoff-v1' as const, incarnation: `inc_${'a'.repeat(32)}`,
    nonce: 'b'.repeat(32), origin, orgId: 'org', sessionId, shiftId: identity.shiftId,
    broker: { socketPath: broker.socketPath, cap: '' }, reservation: reserved.reservation,
    createdAt: 1_000, expiresAt: 70_000, sessionExpiresAt: 90_000 };
  let digest = '';
  const grant = broker.issue({ reservation: reserved.reservation, routing, identity,
    currentIdentity: () => identity, hub, commandFor: async () => 'printf ok',
    inputAuthority: { observe: async (_response, phase) => phase === 'prestart'
      ? { reference: { protocol: 'trusted-routed-reference-read-v2', state: 'available',
        workflow: 'wf', run: 'run', order: activeOrder, inputs: witnesses,
        lease: { claimed: true }, binding: referenceBinding },
      claim: { protocol: 'routing-claim-read-v2', state: 'available', workflow: 'wf', run: 'run',
        routing, binding: referenceBinding } }
      : { reference: { protocol: 'trusted-routed-recorded-reference-read-v2', state: 'available',
        workflow: 'wf', run: 'run', order: activeOrder, inputs: witnesses,
        lease: { claimed: true }, binding: {
          ...referenceBinding, orderDigest: drift ? 'e'.repeat(64) : referenceBinding.orderDigest,
          recordedOccurrence: { reservationId: 'lr_one',
            reportDigest: digest, recordedAt: 2_000, attemptId: 'attempt' } } },
      claim: { protocol: 'routing-recorded-claim-read-v2', state: 'available',
        workflow: 'wf', run: 'run', routing, binding: { ...referenceBinding,
          orderDigest: drift ? 'e'.repeat(64) : referenceBinding.orderDigest,
          recordedOccurrence: { reservationId: 'lr_one', reportDigest: digest,
            recordedAt: 2_000, attemptId: 'attempt' } } } } },
    submissionAuthority: { verifyOrder: async () => {},
      canSubmit: () => scenario !== 'collection' && scenario !== 'collection-lost-seal-ack',
      canCollect: () => scenario === 'collection' || scenario === 'collection-lost-seal-ack',
      canReplay: () => true, sign: async () => {
        signs++;
        if (scenario === 'drift-after-sign') drift = true;
        return 'parent-proof';
      } },
    launchAuthority: { verifySelection: async () => {} } });
  handoff.broker.cap = grant.cap;
  writeFileSync(handoffPath, JSON.stringify(handoff));
  const client = createRoutingChildClient(handoff);
  let record: ReturnType<typeof finalizeChildReservation> | undefined;
  const spawned = createDefaultSpawner(origin, 'default', script, identity.shiftId)(
    { workflow: 'wf', run: 'run', kind: 'exec', startGate: reserved.gatePath,
      routingHandoff: handoffPath, dispatchToken: reserved.reservation.token,
      onGateEntered: entry => {
        if (!record || entry.pid !== record.pid) throw new Error('wrong child');
        grant.markChildEntered(record);
      }, canAllowGateEntry: () => !!record && grant.canAllowEntry(record) });
  try {
    record = finalizeChildReservation(root, reserved.reservation,
      { pid: spawned.pid, spawnedAt: 2_000, kind: 'exec' });
    grant.activate(record);
    grant.bindChild(record, spawned.custody!, { incarnation: handoff.incarnation, nonce: handoff.nonce });
    await client.getOrder({ workflow: 'wf', run: 'run', holder: {
      kind: 'exec', id: `${hostname()}:${spawned.pid}`, shiftId: identity.shiftId } });
    const launch = { version: 'launch-reservation-v1' as const, claimId: 'run',
      decisionId: 'decision', binding, orderId: 'run', attemptId: 'attempt',
      rosterRevision: routing.preference.rosterRevision, candidateIds: [], assessmentId: null,
      requested: null, selected: null };
    if (scenario !== 'no-start') await client.reserveLaunch({ workflow: 'wf', request: launch });
    const report = { version: 'launch-v1' as const, reservationId: 'lr_one', decisionId: 'decision',
      binding, claimId: 'run', orderId: 'run', attemptId: 'attempt', requested: null,
      selected: null, observation: { state: 'unknown' as const } };
    if (scenario !== 'no-start') {
      const accepted = await client.reportLaunch({ workflow: 'wf', report });
      digest = accepted.digest;
    }
    assert.equal(startReservedChild(root, record), true);
    grant.markGateSignalled(record);
    spawned.armGateEntry?.();
    writeFileSync(permit, 'go');
    await waitFor(entered);
    if (scenario === 'no-start') {
      assert.deepEqual(await client.quiesce(), { quiescing: true, effects: 'settled' });
      assert.equal((await client.commandFinish({ observation: 'not-started' })).state, 'released');
      assert.equal((await client.commandFinish({ observation: 'not-started' })).state, 'released');
      assert.equal(requests.filter(row => row.route === 'release').length, 1);
      assert.equal(requests.filter(row => row.route === 'routing_submit_conditional/v1').length, 0);
      return;
    }
    const result = { exitCode: scenario === 'ask-closed' || scenario === 'ask-lost-ack' ? 1 : 0,
      outputHash: `sha256:${'a'.repeat(64)}`,
      stdoutBytes: 2, stderrBytes: 0, outputTail: 'ok',
      startedAt: 1, finishedAt: 2, durationMs: 1 };
    const parsed = rejection ? { payload: { reject: { path: 'source', text: 'bad input' } },
      reject: { path: 'source', text: 'bad input' } } : {};
    const receipt = buildReceipt(result, { command: 'printf ok', orchestrator: `${hostname()}:${spawned.pid}`,
      workflow: 'wf', run: 'run', step: 'build' }, parsed);
    const packet = { result, receipt, parsed: rejection ? { reject: parsed.reject } : {}, group: {
      scope: 'original-posix-group' as const, state: 'empty' as const } };
    await assert.rejects(client.commandPostrun(packet), /routing broker unavailable/,
      'postrun is unavailable before quiesce');
    assert.deepEqual(await client.quiesce(), { quiescing: true, effects: 'settled' });
    if (scenario === 'drift-after-sign') {
      await assert.rejects(client.commandPostrun(packet), /routing broker unavailable/);
      assert.equal(signs, 1);
      assert.equal(requests.filter(row => row.route === 'routing_submit_conditional/v1').length, 0,
        'a changed recorded witness after signing cannot publish a receipt');
      assert.equal((await client.commandFinish({ group: packet.group })).state, 'uncertain');
      return;
    }
    if (scenario === 'lost-submit-ack' || scenario === 'born-rejected'
      || scenario === 'collection-lost-seal-ack')
      await assert.rejects(client.commandPostrun(packet), /routing broker unavailable/);
    if (scenario === 'ask-lost-ack' || scenario === 'reject-lost-ack') {
      await assert.rejects(client.commandPostrun(packet), /routing broker unavailable/);
      await assert.rejects(client.commandPostrun(packet), /routing broker unavailable/);
      const route = scenario === 'ask-lost-ack' ? 'routing_ask/v1' : 'routing_reject/v1';
      assert.equal(requests.filter(row => row.route === route).length, 1,
        'a lost ACK cannot issue a fresh ask or reject');
      assert.equal(requests.filter(row => row.route === 'routing_submit_conditional/v1').length, 0);
      assert.equal((await client.commandFinish({ group: packet.group })).state, 'uncertain');
      return;
    }
    if (scenario === 'schema-rejected') {
      await assert.rejects(client.commandPostrun(packet), /routing broker unavailable/);
      assert.deepEqual(await client.commandPostrun(packet),
	{ outcome: 'submit-rejected', claim: 'held' });
      assert.deepEqual(await client.commandPostrun(packet),
	{ outcome: 'submit-rejected', claim: 'held' });
      assert.equal(signs, 1);
      assert.equal(submits, 1, 'an immutable command receipt cannot mint another intent');
      assert.equal(requests.filter(row => row.route === 'routing_submit_conditional_receipt/v1').length, 1);
      assert.equal((await client.commandFinish({ group: packet.group })).state, 'released');
      return;
    }
    if (scenario === 'born-rejected') {
      assert.deepEqual(await client.commandPostrun(packet),
	{ outcome: 'submit-rejected', claim: 'closed' });
      assert.equal((await client.commandFinish({ group: packet.group })).state, 'already-closed');
      assert.equal(signs, 1);
      assert.equal(submits, 1);
      assert.equal(requests.filter(row => row.route === 'routing_submit_conditional_receipt/v1').length, 1);
      return;
    }
    const expectedOutcome = scenario === 'ask-closed' ? 'command-failed'
      : scenario === 'reject-closed' ? 'rejected' : 'submitted';
    const expectedClaim = scenario === 'submit-held' ? 'held' : 'closed';
    assert.deepEqual(await client.commandPostrun(packet), { outcome: expectedOutcome, claim: expectedClaim });
    assert.deepEqual(await client.commandPostrun(packet), { outcome: expectedOutcome, claim: expectedClaim });
    await assert.rejects(client.commandPostrun({ ...packet, receipt: { ...receipt, outputTail: 'changed' } }),
      /routing broker unavailable/);
    assert.equal((await client.commandFinish({ group: packet.group })).state,
      scenario === 'submit-held' ? 'released' : 'already-closed');
    assert.equal(signs, scenario === 'ask-closed' || scenario === 'reject-closed' ? 0
      : scenario === 'collection' || scenario === 'collection-lost-seal-ack'
        || scenario === 'multi-output' ? 2 : 1);
    assert.equal(requests.filter(row => row.route === 'routing_submit_conditional/v1').length,
      scenario === 'multi-output' ? 2 : scenario === 'ask-closed'
        || scenario === 'reject-closed' || scenario === 'collection'
        || scenario === 'collection-lost-seal-ack' ? 0 : 1);
    if (scenario === 'lost-submit-ack') {
      const write = requests.find(row => row.route === 'routing_submit_conditional/v1')!;
      const read = requests.find(row => row.route === 'routing_submit_conditional_receipt/v1')!;
      assert.equal((read.body as { intentId: string }).intentId, write.intent);
      assert.equal((read.body as { requestDigest: string }).requestDigest,
	createHash('sha256').update(write.rawBody).digest('hex'));
      assert.equal(requests.slice(requests.indexOf(write) + 1).some(row => row.route === 'get_order'), false,
	'closed-run reconciliation performs no new order read');
    }
    if (scenario === 'collection' || scenario === 'collection-lost-seal-ack') {
      assert.deepEqual(requests.filter(row => row.route.startsWith('routing_collection_'))
        .map(row => row.route), ['routing_collection_member_issue/v1',
	'routing_collection_member_emit/v1', 'routing_collection_seal/v1',
	...(scenario === 'collection-lost-seal-ack' ? ['routing_collection_seal/v1'] : [])]);
    }
    const write = requests.find(row => row.route === 'routing_submit_conditional/v1');
    if (write) {
      assert.equal(write.session, credential);
      assert.equal((write.body as { proof: string }).proof, 'parent-proof');
      assert.equal((write.body as { holder: { id: string } }).holder.id, `${hostname()}:${spawned.pid}`);
    }
  } finally {
    spawned.cancel?.();
    await broker.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
