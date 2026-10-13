import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { createDefaultSpawner, retainedChildLive } from '../src/shift/spawn.ts';
import { finalizeChildReservation, reserveChild, startReservedChild } from '../src/shift/state.ts';

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
const selected = { id: 'tuple_one', harness: 'codex', model: 'model-one', effort: 'medium' } as const;
const routing = { claim: { state: 'claimed', claimId: 'run', decisionId: 'decision', binding,
  invocationId: null, orderId: 'run', attemptId: 'attempt_distinct', principalId: 'agent',
  sessionId, shiftId: 'shf_service' },
decision: { decisionId: 'decision', binding, status: 'applied', applied: null, effect: null },
preference: { offer: null, tuples: [{ tuple: selected, eligible: true, available: true }],
  role: 'implementation', rolePolicy: null,
  rosterRevision: 'a'.repeat(64), expiresAt: 70_000 } } as ReferenceRouting;
const expected = { workflow: 'wf', run: 'run' };
const referenceBinding = { rootWorkflow: 'wf', frameWorkflow: 'frame', run: 'run',
  claimId: 'run', decisionId: 'decision', sessionId, shiftId: 'shf_service',
  orderDigest: 'b'.repeat(64), authorityRevision: 'c'.repeat(64),
  rosterRevision: routing.preference.rosterRevision, routingDigest: valueDigestHex(routing),
  preferenceExpiresAt: routing.preference.expiresAt };
const order = { workflow: 'frame', run: 'run', step: 'build', key: '', defDigest: 'd'.repeat(64),
  inputs: [], outputs: ['out'], consumes: {}, consumedFingerprint: {},
  owes: [{ path: 'out', version: 1 }], routing } as unknown as OrderPacket;

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (existsSync(path)) return;
    await sleep(10);
  }
  throw new Error('child did not enter its gate');
}

test('only the retained exact child after gate entry can read a recorded occurrence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-live-child-'));
  let now = 2_000;
  let liveIdentity = identity;
  let reportDigest = '';
  const verbs: string[] = [];
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => now },
    fetchImpl: (async (url, init) => {
      const verb = String(url).split('/').at(-1)!;
      verbs.push(verb);
      if (verb === 'get_order') return Response.json({ text: 'ok', ...expected,
	workflow: 'frame', lease: { claimed: true }, order });
      if (verb === 'heartbeat') return Response.json({ text: 'ok', ok: true });
      if (verb === 'reserve_launch') return Response.json({ reservationId: 'lr_one',
	orderId: 'run', expiresAt: 65_000 });
      if (verb === 'report_launch') {
	reportDigest = valueDigestHex(JSON.parse(String(init!.body)).report);
	return Response.json({ orderId: 'run', digest: reportDigest,
	  recordedAt: 2_000, provenance: 'authenticated-worker-report' });
      }
      throw new Error('unexpected Hub verb');
    }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => now });
  const permit = join(root, 'permit'), entered = join(root, 'entered');
  const script = join(root, 'role.mjs');
  writeFileSync(script, `import { existsSync } from 'node:fs';\n`
    + `import { readFile, writeFile, unlink } from 'node:fs/promises';\n`
    + `import { setTimeout as sleep } from 'node:timers/promises';\n`
    + `for (;;) { try { if ((await readFile(process.env.OWENLOOP_START_GATE, 'utf8')).trim() === 'start') break; } catch {} await sleep(5); }\n`
    + `const h = JSON.parse(await readFile(process.env.OWENLOOP_ROUTING_HANDOFF, 'utf8'));\n`
    + `await unlink(process.env.OWENLOOP_ROUTING_HANDOFF);\n`
    + `while (!existsSync(${JSON.stringify(permit)})) await sleep(5);\n`
    + `process.once('message', async reply => { await writeFile(${JSON.stringify(entered)}, String(reply?.type === 'routing-gate-entry-allowed')); if (process.connected) process.disconnect(); });\n`
    + `process.send({type:'routing-gate-entered',dispatchToken:h.reservation.token,routingHandoff:process.env.OWENLOOP_ROUTING_HANDOFF});\n`
    + `setInterval(() => {}, 1000);\n`);
  const reserved = reserveChild(root, { ...expected, childKind: 'agent-run', reservedAt: 1_000 });
  const handoffPath = join(root, 'handoff.json');
  const handoff = { version: 'routing-handoff-v1' as const, incarnation: `inc_${'a'.repeat(32)}`,
    nonce: 'b'.repeat(32), origin, orgId: 'org', sessionId, shiftId: 'shf_service',
    broker: { socketPath: broker.socketPath, cap: '' }, reservation: reserved.reservation,
    createdAt: 1_000, expiresAt: 70_000, sessionExpiresAt: 90_000 };
  let resolveDelayed!: (value: unknown) => void;
  let delayed = false;
  let badMode: 'frame' | 'reservation' | 'report' | undefined;
  const liveRead = async (kind: 'reference' | 'claim') => {
    if (delayed) return new Promise<unknown>(resolve => { resolveDelayed = resolve; });
    const recordedOccurrence = { reservationId: badMode === 'reservation' ? 'lr_wrong' : 'lr_one',
      reportDigest: badMode === 'report' ? 'f'.repeat(64) : reportDigest,
      recordedAt: 2_000, attemptId: 'attempt_distinct' };
    const fullBinding = { ...referenceBinding,
      frameWorkflow: badMode === 'frame' ? 'other' : 'frame', recordedOccurrence };
    return kind === 'reference'
      ? { protocol: 'trusted-routed-recorded-reference-read-v2', state: 'available', ...expected,
	order, inputs: [], lease: { claimed: true }, binding: fullBinding }
      : { protocol: 'routing-recorded-claim-read-v2', state: 'available', ...expected,
	routing, binding: fullBinding };
  };
  const phases: string[] = [];
  const invocationPhases: string[] = [];
  let invocationReads = 0;
  let pauseInvocation = false;
  let invocationEntered!: () => void;
  let resumeInvocation!: () => void;
  const invocationStarted = new Promise<void>(resolve => { invocationEntered = resolve; });
  const invocationKey = { workflow: 'wf', orderId: 'run', parentWorkflow: 'frame',
    parentDefRef: { bundleDigest: 'sha256:bundle', workflowName: 'wf' },
    callPath: 'child', parentArtifactVersion: 1 };
  const invocationRelay = { receipt: { invocationId: 'inv', parentDefRef: invocationKey.parentDefRef,
    callPath: 'child', evidenceDigest: 'a'.repeat(64), parentArtifactVersion: 1,
    childWorkflow: 'wf_child', childDefRef: invocationKey.parentDefRef,
    childOutcome: 'ok', childOutcomeVersion: 1 }, receiptDigest: 'b'.repeat(64) };
  const prestartRead = async (kind: 'reference' | 'claim'): Promise<RoutedReferenceV2 | RoutedClaimV2> => kind === 'reference'
    ? { protocol: 'trusted-routed-reference-read-v2', state: 'available', ...expected,
	order, inputs: [], lease: { claimed: true }, binding: referenceBinding }
    : { protocol: 'routing-claim-read-v2', state: 'available', ...expected,
	routing, binding: referenceBinding };
  const grant = broker.issue({ reservation: reserved.reservation, routing, identity,
    currentIdentity: () => liveIdentity, hub,
    routedV2Read: prestartRead,
    routedLiveV2Read: liveRead as NonNullable<Parameters<typeof broker.issue>[0]['routedLiveV2Read']>,
    inputAuthority: { validateInvocationKey: key => key.parentWorkflow === 'frame'
      && key.parentDefRef.bundleDigest === 'sha256:bundle'
      && key.parentDefRef.workflowName === 'wf'
      && key.callPath === 'child' && key.parentArtifactVersion === 1,
      observeInvocation: async (_response, phase) => {
	invocationReads++;
	invocationPhases.push(phase);
	if (pauseInvocation) {
	  invocationEntered();
	  await new Promise<void>(resolve => { resumeInvocation = resolve; });
	}
	return { pair: phase === 'prestart'
	  ? { reference: await prestartRead('reference') as RoutedReferenceV2,
	    claim: await prestartRead('claim') as RoutedClaimV2 }
	  : { reference: await liveRead('reference') as RecordedReferenceV2,
	    claim: await liveRead('claim') as RecordedClaimV2 }, relay: invocationRelay };
      }, observe: async (_response, phase) => {
	phases.push(phase);
	return phase === 'prestart'
	  ? { reference: await prestartRead('reference') as RoutedReferenceV2,
	    claim: await prestartRead('claim') as RoutedClaimV2 }
	  : { reference: await liveRead('reference') as RecordedReferenceV2,
	    claim: await liveRead('claim') as RecordedClaimV2 };
    } },
    submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => true, sign: async () => 'proof' },
    launchAuthority: { verifySelection: async () => {} } });
  handoff.broker.cap = grant.cap;
  writeFileSync(handoffPath, JSON.stringify(handoff));
  const client = createRoutingChildClient(handoff);
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const spawner = createDefaultSpawner(origin, 'default', script, 'shf_service', undefined,
    undefined, undefined, () => exited());
  let rec: ReturnType<typeof finalizeChildReservation> | undefined;
  const terminalReasons: Array<'exit' | 'start-failure' | 'cancel' | undefined> = [];
  const spawned = spawner({ ...expected, kind: 'agent-run', startGate: reserved.gatePath,
    routingHandoff: handoffPath, dispatchToken: reserved.reservation.token,
    onGateEntered: entry => {
      if (!rec || entry.pid !== rec.pid || entry.dispatchToken !== reserved.reservation.token
	|| entry.routingHandoff !== handoffPath) throw new Error('wrong child entry');
      grant.markChildEntered(rec);
    },
    canAllowGateEntry: () => !!rec && grant.canAllowEntry(rec),
    onTerminal: reason => { terminalReasons.push(reason); if (reason !== 'exit') grant.terminal(); } });
  try {
    assert.equal(retainedChildLive(spawned.custody, spawned.pid), true);
    rec = finalizeChildReservation(root, reserved.reservation,
      { pid: spawned.pid, spawnedAt: 2_000, kind: 'agent-run' });
    const record = rec;
    grant.activate(record);
    grant.bindChild(record, spawned.custody!, { incarnation: handoff.incarnation, nonce: handoff.nonce });
    const send = async (cap: string, method: string, body: unknown) => {
      const { createConnection } = await import('node:net');
      return new Promise<Record<string, unknown>>((resolve, reject) => {
	const socket = createConnection(broker.socketPath); let raw = '';
	socket.once('connect', () => socket.write(JSON.stringify({ cap, method, body }) + '\n'));
	socket.on('data', chunk => { raw += chunk.toString(); if (raw.includes('\n')) {
	  socket.destroy(); resolve(JSON.parse(raw.slice(0, raw.indexOf('\n'))) as Record<string, unknown>);
	} });
	socket.once('error', reject);
      });
    };
    assert.equal((await send(grant.cap, 'read_live_routed_reference_v2', {})).ok, false);
    assert.equal((await send(grant.cap, 'child_entered', { incarnation: handoff.incarnation,
      nonce: handoff.nonce, reservationToken: reserved.reservation.token })).ok, false);
    assert.equal(startReservedChild(root, record), true);
    assert.throws(() => grant.markGateSignalled({ ...record, pid: record.pid + 1 }),
      /child gate unavailable/);
    grant.markGateSignalled(record);
    spawned.armGateEntry?.();
    assert.equal((await send(grant.cap, 'read_live_routed_reference_v2', {})).ok, false,
      'gate signal without exact child entry has no live read authority');
    assert.equal((await send(grant.holder!.cap, 'read_live_routed_reference_v2', {})).ok, false);
    assert.equal((await send(grant.cap, 'child_entered', { incarnation: handoff.incarnation,
      nonce: 'f'.repeat(32), reservationToken: reserved.reservation.token })).ok, false,
      'a role-cap socket cannot impersonate the direct child IPC entry');
    await client.readRoutedReferenceV2(expected);
    const beforeInvalidKey = verbs.length;
    assert.equal((await send(grant.cap, 'read_invocation_binding', {
      parentWorkflow: invocationKey.parentWorkflow, parentDefRef: invocationKey.parentDefRef,
      callPath: invocationKey.callPath })).ok, false);
    for (const changed of [{ ...invocationKey, parentWorkflow: 'other' },
      { ...invocationKey, parentArtifactVersion: 2 },
      { ...invocationKey, parentDefRef: { ...invocationKey.parentDefRef, workflowName: 'sibling' } }])
      await assert.rejects(client.readInvocationBinding(changed), /routing broker unavailable/);
    assert.equal(invocationReads, 0, 'wrong key cannot trigger direct parent relay reads');
    assert.equal(verbs.length, beforeInvalidKey, 'wrong key is refused before a scoped order read');
    const beforePrestartOrder = verbs.filter(verb => verb === 'get_order').length;
    const beforePrestartBinder = phases.length;
    assert.deepEqual(await client.readInvocationBinding(invocationKey), invocationRelay);
    assert.equal(verbs.filter(verb => verb === 'get_order').length, beforePrestartOrder + 1);
    assert.equal(phases.length, beforePrestartBinder,
      'one invocation request does not run a separate full input observation');
    assert.deepEqual(invocationPhases, ['prestart']);
    assert.deepEqual(await client.readInvocationBinding(invocationKey), invocationRelay);
    assert.equal(verbs.filter(verb => verb === 'get_order').length, beforePrestartOrder + 2,
      'a later invocation socket request obtains another current order');
    assert.equal(phases.length, beforePrestartBinder);
    now = 70_000;
    await assert.rejects(client.readInvocationBinding(invocationKey), /routing broker unavailable/);
    assert.equal(verbs.filter(verb => verb === 'get_order').length, beforePrestartOrder + 2,
      'an expired startup preference refuses before the parent order read');
    now = 2_000;
    assert.equal((await client.heartbeat({ ...expected, holder: { kind: 'exec',
	id: `${hostname()}:${record.pid}`, shiftId: 'shf_service' } })).text, 'ok');
    assert.equal(phases.at(-1), 'prestart');
    const request = { version: 'launch-reservation-v1' as const, claimId: 'run',
      decisionId: 'decision', binding, orderId: 'run', attemptId: 'attempt_distinct',
      rosterRevision: routing.preference.rosterRevision, candidateIds: [selected.id], assessmentId: null,
      requested: null, selected };
    await client.reserveLaunch({ workflow: 'wf', request });
    await client.reportLaunch({ workflow: 'wf', report: { version: 'launch-v1',
      reservationId: 'lr_one', decisionId: 'decision', binding, claimId: 'run',
      orderId: 'run', attemptId: 'attempt_distinct', requested: null, selected,
      observation: { state: 'unknown' } } });
    await assert.rejects(client.readInvocationBinding(invocationKey), /routing broker unavailable/,
      'accepted report without entered child cannot downgrade to prestart read');
    assert.equal(invocationReads, 2);
    assert.equal((await send(grant.cap, 'read_live_routed_reference_v2', {})).ok, false,
      'an accepted report before direct-child gate entry grants no live read');
    writeFileSync(permit, 'go');
    await waitFor(entered);
    assert.equal((await import('node:fs')).readFileSync(entered, 'utf8'), 'true');
    assert.equal(retainedChildLive(spawned.custody, spawned.pid), true,
      'successful IPC disconnect is not role exit');
    assert.deepEqual(terminalReasons, []);
    const beforeRecordedOrder = verbs.filter(verb => verb === 'get_order').length;
    const beforeRecordedBinder = phases.length;
    assert.deepEqual(await client.readInvocationBinding(invocationKey), invocationRelay);
    assert.equal(verbs.filter(verb => verb === 'get_order').length, beforeRecordedOrder + 1);
    assert.equal(phases.length, beforeRecordedBinder);
    assert.deepEqual(invocationPhases, ['prestart', 'prestart', 'recorded-live']);
    await assert.rejects(createRoutingChildClient({ ...handoff,
      broker: grant.holder! }).readInvocationBinding(invocationKey), /routing broker unavailable/);
    now = 70_000;
    assert.equal((await client.heartbeat({ ...expected, holder: { kind: 'exec',
	id: `${hostname()}:${record.pid}`, shiftId: 'shf_service' } })).text, 'ok',
      'entered child can renew after the initial preference expires');
    assert.equal(phases.at(-1), 'recorded-live');
    assert.equal((await client.readLiveRoutedReferenceV2(expected)).state, 'available',
      'elapsed startup preference does not end an entered child claim');
    assert.equal((await client.readLiveRoutingClaimV2(expected)).state, 'available');
    badMode = 'frame';
    await assert.rejects(client.readInvocationBinding(invocationKey), /routing broker unavailable/,
      'a verified relay cannot excuse a moved recorded frame');
    await assert.rejects(client.readLiveRoutingClaimV2(expected), /routing broker unavailable/);
    badMode = 'reservation';
    await assert.rejects(client.readLiveRoutedReferenceV2(expected), /routing broker unavailable/);
    badMode = 'report';
    await assert.rejects(client.readLiveRoutingClaimV2(expected), /routing broker unavailable/);
    badMode = undefined;
    pauseInvocation = true;
    const pendingInvocation = client.readInvocationBinding(invocationKey);
    await invocationStarted;
    liveIdentity = { ...identity, sessionId: 'rs_rotated' };
    resumeInvocation();
    await assert.rejects(pendingInvocation, /routing broker unavailable/,
      'a revoked original session cannot return an awaited relay');
    liveIdentity = identity;
    pauseInvocation = false;
    const previousCalls = verbs.length;
    delayed = true;
    const pending = client.readLiveRoutedReferenceV2(expected);
    for (let i = 0; i < 100 && !resolveDelayed; i++) await sleep(5);
    assert.ok(resolveDelayed);
    spawned.cancel?.();
    delayed = false;
    resolveDelayed(await liveRead('reference'));
    await assert.rejects(pending, /routing broker unavailable/);
    assert.equal(retainedChildLive(spawned.custody, spawned.pid), false);
    assert.deepEqual(verbs.slice(previousCalls), ['get_order'],
      'live read reobserves the claim without another reservation or report');
  } finally {
    spawned.cancel?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
    if (timer) clearTimeout(timer);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing reserved gate never records a successful first signal', () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-missing-gate-'));
  try {
    const reserved = reserveChild(root, { ...expected, childKind: 'exec', reservedAt: 1_000 });
    const record = finalizeChildReservation(root, reserved.reservation,
      { pid: 9001, spawnedAt: 2_000, kind: 'exec' });
    unlinkSync(reserved.gatePath);
    assert.throws(() => startReservedChild(root, record), /ENOENT/);
    assert.equal(startReservedChild(root, { ...record, gateToken: undefined }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parent refuses stale IPC identity, stop, and rotation before allow is queued', async () => {
  for (const mismatch of ['token', 'path', 'stop', 'rotation'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'routed-stale-entry-'));
    const handoffPath = join(root, 'handoff.json');
    const marker = join(root, 'reply');
    const script = join(root, 'role.mjs');
    const reserved = reserveChild(root, { ...expected, childKind: 'exec', reservedAt: 1_000 });
    writeFileSync(script, `import { readFile, writeFile } from 'node:fs/promises';\n`
      + `for (;;) { if ((await readFile(process.env.OWENLOOP_START_GATE,'utf8')).trim()==='start') break; }\n`
      + `process.once('message', async m => { await writeFile(${JSON.stringify(marker)}, String(m?.type)); process.exit(0); });\n`
      + `process.once('disconnect', async () => { await writeFile(${JSON.stringify(marker)}, 'disconnected'); process.exit(0); });\n`
      + `process.send({type:'routing-gate-entered',dispatchToken:${mismatch === 'token'
	? JSON.stringify('f'.repeat(32)) : JSON.stringify(reserved.reservation.token)},`
      + `routingHandoff:${JSON.stringify(mismatch === 'path' ? join(root, 'other.json') : handoffPath)}});\n`);
    const reasons: string[] = [];
    let accepted = 0;
    let rotated = false;
    const spawner = createDefaultSpawner(origin, 'default', script);
    const spawned = spawner({ ...expected, startGate: reserved.gatePath,
      routingHandoff: handoffPath, dispatchToken: reserved.reservation.token,
      onGateEntered: () => {
	accepted++;
	if (mismatch === 'rotation') rotated = true;
	if (mismatch === 'stop') spawned.cancel?.();
      },
      canAllowGateEntry: () => !rotated,
      onTerminal: reason => { reasons.push(reason ?? 'unknown'); } });
    try {
      const record = finalizeChildReservation(root, reserved.reservation,
	{ pid: spawned.pid, spawnedAt: 2_000, kind: 'exec' });
      assert.equal(startReservedChild(root, record), true);
      spawned.armGateEntry?.();
      if (mismatch === 'stop') {
	for (let i = 0; i < 500 && accepted === 0; i++) await sleep(10);
	assert.equal(accepted, 1);
	assert.deepEqual(reasons, ['cancel']);
      } else {
	await waitFor(marker);
	assert.equal(accepted, mismatch === 'rotation' ? 1 : 0);
	assert.deepEqual(reasons, ['start-failure']);
	assert.notEqual((await import('node:fs')).readFileSync(marker, 'utf8'), 'routing-gate-entry-allowed');
      }
      assert.equal(retainedChildLive(spawned.custody, spawned.pid), false);
    } finally {
      spawned.cancel?.();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
