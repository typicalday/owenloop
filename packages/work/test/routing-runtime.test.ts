import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { run as runAgent } from '../src/roles/agent-run.ts';
import { run as runExec } from '../src/roles/exec.ts';
import { consumeRoutingHandoff } from '../src/roles/routing-handoff.ts';
import { reserveChild } from '../src/shift/state.ts';
import { buildSpawnPlan } from '../src/shift/spawn.ts';
import { createRoutingBackoff, createRoutingStop, openShiftRoutingSession, selectLocalRoutingTuples } from '../src/shift/runtime.ts';
import { createHubClient } from '../src/hub/client.ts';
import { HubError } from '../src/hub/types.ts';
import { writeHubRosterCache } from '../src/settings/hub-roster-cache.ts';
import type { RoutingOfferCandidate } from '../src/hub/types.ts';

const origin = 'https://hub.example.test';
const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const credential = `rs1.${sessionId}.${'x'.repeat(43)}`;

test('failed broker drain still parks the original session until its live handoff exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-stop-'));
  const calls: string[] = [];
  let reportClose!: () => void;
  const closed = new Promise<void>(resolve => { reportClose = resolve; });
  const now = 1_000;
  try {
    const session = await openShiftRoutingSession({ stateDir: root, origin, orgId: 'org',
      principalId: 'actor', scope: { workflows: ['wf'] }, now: () => now,
      getToken: async () => 'enrolled',
      fetchImpl: (async url => {
	const route = String(url).split('/').at(-1)!;
	calls.push(route);
	if (route === 'routing_session_open') return Response.json({ sessionId,
	  shiftId: 'shf_service', credential, expiresAt: 900_000 });
	if (route === 'routing_session_close') { reportClose(); return Response.json({ closed: true }); }
	throw new Error(`unexpected ${route}`);
      }) as typeof fetch,
    });
    const reservation = reserveChild(root, { workflow: 'wf', run: 'run',
      childKind: 'exec', reservedAt: now }).reservation;
    const handoff = session.createHandoff(reservation);
    const stop = createRoutingStop(() => {
      calls.push('broker-local-revoke');
      return Promise.reject(new Error('remote receipt revoke uncertain'));
    }, () => session.stop());
    const stopped = assert.rejects(stop(), /remote receipt revoke uncertain/);
    assert.equal(calls.at(-1), 'broker-local-revoke', 'local revocation begins synchronously');
    await stopped;
    assert.equal(calls.includes('routing_session_close'), false,
      'live handoff keeps the original session for bounded post-stop custody');
    handoff.terminal();
    await Promise.race([closed, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('original session did not close')), 1_000))]);
    assert.deepEqual(calls, ['routing_session_open', 'broker-local-revoke', 'routing_session_close']);
    await assert.rejects(stop(), /remote receipt revoke uncertain/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scope rotation blocks new identity until old-session revoke settles and quarantines failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-rotation-'));
  const secondId = 'rs_87654321-4321-4321-4321-cba987654321';
  const secondCredential = `rs1.${secondId}.${'y'.repeat(43)}`;
  let opens = 0;
  let beginRevoke!: () => void;
  const revoking = new Promise<void>(resolve => { beginRevoke = resolve; });
  let finishRevoke!: () => void;
  const held = new Promise<void>(resolve => { finishRevoke = resolve; });
  const seen: string[] = [];
  try {
    const session = await openShiftRoutingSession({ stateDir: root, origin, orgId: 'org',
      principalId: 'actor', scope: { workflows: ['wf'] }, now: () => 1_000,
      getToken: async () => 'enrolled',
      onRetiring: async original => {
	seen.push(original);
	beginRevoke();
	await held;
	throw new Error('remote revoke unavailable');
      },
      fetchImpl: (async url => {
	const route = String(url).split('/').at(-1)!;
	if (route === 'routing_session_open') {
	  opens++;
	  return Response.json({ sessionId: opens === 1 ? sessionId : secondId,
	    shiftId: 'shf_service', credential: opens === 1 ? credential : secondCredential,
	    expiresAt: 900_000 });
	}
	if (route === 'routing_session_close') return Response.json({ closed: true });
	throw new Error(`unexpected ${route}`);
      }) as typeof fetch,
    });
    const rotating = session.ensureScope({ crews: ['next'], capabilities: [] });
    await revoking;
    assert.equal(session.identity(), undefined, 'new session cannot issue grants during remote revoke');
    assert.equal(session.brokerTarget(), undefined);
    finishRevoke();
    await assert.rejects(rotating, /remote revoke unavailable/);
    assert.deepEqual(seen, [sessionId]);
    assert.equal(session.identity(), undefined, 'unknown revocation quarantines later grants');
    await session.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('routed bootstrap roster 429 blocks whoami and session open until Retry-After', async () => {
  let monotonic = 0;
  const calls: string[] = [];
  const backoff = createRoutingBackoff(() => monotonic);
  const client = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => undefined,
      beforeRequest: backoff.beforeRequest, onRateLimit: backoff.onRateLimit },
    fetchImpl: (async url => {
      const verb = new URL(String(url)).pathname.split('/').at(-1)!;
      calls.push(verb);
      if (verb === 'rosters') return Response.json({ error: 'rate_limited' },
	{ status: 429, headers: { 'Retry-After': '120' } });
      if (verb === 'whoami') return Response.json({});
      if (verb === 'routing_session_open') return Response.json({ sessionId, shiftId: 'shf_service', credential, expiresAt: 900_000 });
      throw new Error(`unexpected ${verb}`);
    }) as typeof fetch,
  });
  await assert.rejects(client.getRosters!(), error => error instanceof HubError && error.status === 429);
  await assert.rejects(client.whoami(), error => error instanceof HubError && error.status === 429);
  await assert.rejects(client.openRoutingSession({ scope: { workflows: ['wf'] } }),
    error => error instanceof HubError && error.status === 429);
  assert.deepEqual(calls, ['rosters']);
  monotonic = 119_999;
  await assert.rejects(client.whoami(), error => error instanceof HubError && error.status === 429);
  assert.deepEqual(calls, ['rosters']);
  monotonic = 120_000;
  await client.whoami();
  await client.openRoutingSession({ scope: { workflows: ['wf'] } });
  assert.deepEqual(calls, ['rosters', 'whoami', 'routing_session_open']);
});

test('spawn plans transport only an explicit handoff and strip ambient bearer for routed workers', () => {
  const previous = { handoff: process.env.OWENLOOP_ROUTING_HANDOFF, token: process.env.OWENLOOP_TOKEN };
  try {
    process.env.OWENLOOP_ROUTING_HANDOFF = '/foreign/handoff';
    process.env.OWENLOOP_TOKEN = 'ambient-secret';
    const base = { workflow: 'wf', run: 'run' };
    const legacy = buildSpawnPlan(base, origin, 'default', '/bin/owenloop', '/bin/node');
    assert.equal(legacy.options.env?.OWENLOOP_ROUTING_HANDOFF, undefined);
    assert.equal(legacy.options.env?.OWENLOOP_TOKEN, 'ambient-secret');
    const routed = buildSpawnPlan({ ...base, routingHandoff: '/private/handoff', routingShiftId: 'shf_service' },
      origin, 'default', '/bin/owenloop', '/bin/node', 'shf_legacy');
    assert.equal(routed.options.env?.OWENLOOP_ROUTING_HANDOFF, '/private/handoff');
    assert.equal(routed.options.env?.OWENLOOP_TOKEN, undefined);
    assert.deepEqual(routed.args.slice(-2), ['--shift', 'shf_service']);
  } finally {
    if (previous.handoff === undefined) delete process.env.OWENLOOP_ROUTING_HANDOFF;
    else process.env.OWENLOOP_ROUTING_HANDOFF = previous.handoff;
    if (previous.token === undefined) delete process.env.OWENLOOP_TOKEN;
    else process.env.OWENLOOP_TOKEN = previous.token;
  }
});

test('role startup consumes an incomplete private handoff before any legacy effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-role-'));
  const now = Date.now();
  const calls: string[] = [];
  try {
    const session = await openShiftRoutingSession({ stateDir: root, workRoot: join(root, 'work'),
      origin, orgId: 'org', principalId: 'actor',
      scope: { workflows: ['wf'], capabilities: ['build'] }, now: () => now, getToken: async () => 'enrolled',
      fetchImpl: (async (url, init) => {
	const verb = String(url).split('/').at(-1)!;
	calls.push(verb);
	if (verb === 'routing_session_open') return Response.json({ sessionId, shiftId: 'shf_service', credential, expiresAt: now + 900_000 });
	assert.equal(new Headers(init?.headers).get('X-Owenloop-Routing-Session'), credential);
	if (verb === 'routing_session_close') return Response.json({ closed: true });
	throw new Error(`unexpected ${verb}`);
      }) as typeof fetch,
    });
    const reserve = (run: string, kind: 'exec' | 'agent-run') => reserveChild(root, {
      workflow: 'wf', run, childKind: kind, reservedAt: now,
    }).reservation;
    const agent = session.createHandoff(reserve('agent', 'agent-run'));
    assert.equal(JSON.parse(readFileSync(agent.path, 'utf8')).workRoot, join(root, 'work'));
    mkdirSync(join(root, '.owenloop'), { recursive: true });
    writeFileSync(join(root, '.owenloop', 'settings.json'), '{malformed-json');
    const env: Record<string, string | undefined> = { HOME: root, OWENLOOP_ROUTING_HANDOFF: agent.path,
      OWENLOOP_ROUTING_SESSION: '1', OWENLOOP_TOKEN: 'ambient-secret' };
    const errors: string[] = [];
    assert.equal(await runAgent(['wf/agent', '--origin', origin], { env, err: line => errors.push(line) }), 1);
    assert.match(errors.at(-1)!, /routing handoff refused/);
    assert.equal(env.OWENLOOP_TOKEN, undefined);
    assert.equal(env.OWENLOOP_ROUTING_HANDOFF, undefined);
    assert.equal(existsSync(agent.path), false);
    agent.terminal();

    const command = session.createHandoff(reserve('command', 'exec'));
    const commandEnv: Record<string, string | undefined> = { HOME: root, OWENLOOP_ROUTING_HANDOFF: command.path };
    assert.equal(await runExec(['wf/command', '--origin', origin], { env: commandEnv, err: line => errors.push(line) }), 1);
    assert.match(errors.at(-1)!, /routing handoff refused/);
    assert.equal(existsSync(command.path), false);
    command.terminal();

    const missing = { HOME: root, OWENLOOP_ROUTING_SESSION: '1' };
    assert.equal(await runAgent(['wf/missing', '--origin', origin], { env: missing, err: line => errors.push(line) }), 1);
    assert.match(errors.at(-1)!, /routing handoff refused/);
    assert.deepEqual(calls, ['routing_session_open']);
    await session.stop();
    assert.deepEqual(calls, ['routing_session_open', 'routing_session_close']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('complete routed role preflight opens public stage, then retains the launch fence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-stage-role-'));
  const now = Date.now();
  try {
    const workRoot = join(root, 'work');
    const session = await openShiftRoutingSession({ stateDir: root, workRoot,
      origin, orgId: 'org', principalId: 'actor',
      scope: { workflows: ['wf'], capabilities: ['build'] }, now: () => now, getToken: async () => 'enrolled',
      fetchImpl: (async url => String(url).endsWith('/routing_session_open')
	? Response.json({ sessionId, shiftId: 'shf_service', credential, expiresAt: now + 900_000 })
	: Response.json({ closed: true })) as typeof fetch });
    const stageRoot = join(root, '.routing-definitions');
    mkdirSync(stageRoot, { mode: 0o700 });
    const makeStage = (run: string) => {
      const path = mkdtempSync(join(stageRoot, '.routing-def-'));
      mkdirSync(join(path, 'public'), { mode: 0o700 });
      mkdirSync(join(path, 'home'), { mode: 0o700 });
      const digest = 'a'.repeat(64);
      writeFileSync(join(path, 'stage.json'), JSON.stringify({ version: 'routing-definition-stage-v1',
	workflow: 'wf', run, step: 'build', digest, bundleDigest: 'b'.repeat(64),
	originRules: {}, nonce: 'c'.repeat(32) }), { mode: 0o600 });
      return { path, digest, verifyOrder: async () => {}, canSubmit: () => false,
	canReplay: () => false, activate: () => {}, markGateMayOpen: () => {},
	cleanupAfterExit: () => rmSync(path, { recursive: true, force: true }),
	cleanup: () => rmSync(path, { recursive: true, force: true }) };
    };
    const broker = { socketPath: join(tmpdir(), 'ol-rb-ABCDEF', 'broker.sock'), cap: 'd'.repeat(64) };
    for (const kind of ['agent-run', 'exec'] as const) {
      const run = kind === 'agent-run' ? 'agent' : 'command';
      const stage = makeStage(run);
      const reservation = reserveChild(root, { workflow: 'wf', run, childKind: kind, reservedAt: now }).reservation;
      const handoff = session.createHandoff(reservation, broker, stage);
      const env = { HOME: root, OWENLOOP_ROUTING_HANDOFF: handoff.path };
      const errors: string[] = [];
      const status = kind === 'agent-run'
	? await runAgent([`wf/${run}`, '--origin', origin], { env, err: line => errors.push(line) })
	: await runExec([`wf/${run}`, '--origin', origin], { env, err: line => errors.push(line) });
      assert.equal(status, 1);
      assert.match(errors.at(-1)!, /routed launch fence unavailable/);
      assert.equal(existsSync(handoff.path), false);
      if (kind === 'agent-run') assert.equal(existsSync(join(workRoot, 'wf', 'agent')), false);
      handoff.terminal();
      stage.cleanup();
    }
    await session.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('handoff refuses wrong target, malformed session identity, and expired authority without fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-refuse-'));
  let now = 1_000;
  try {
    const session = await openShiftRoutingSession({ stateDir: root, origin, orgId: 'org', principalId: 'actor',
      scope: { workflows: ['wf'], capabilities: ['build'] }, now: () => now, getToken: async () => 'enrolled',
      fetchImpl: (async url => String(url).endsWith('/routing_session_open')
	? Response.json({ sessionId, shiftId: 'shf_service', credential, expiresAt: 900_000 })
	: Response.json({ closed: true })) as typeof fetch,
    });
    const handoff = (run: string) => session.createHandoff(reserveChild(root, {
      workflow: 'wf', run, childKind: 'agent-run', reservedAt: now,
    }).reservation);
    const wrongTarget = handoff('target');
    assert.throws(() => consumeRoutingHandoff({ env: { OWENLOOP_ROUTING_HANDOFF: wrongTarget.path }, origin,
      target: { workflow: 'wf', run: 'other' }, kind: 'agent-run', now: () => now }), /refused/);
    assert.equal(existsSync(wrongTarget.path), false);
    wrongTarget.terminal();

    const wrongSession = handoff('session');
    const payload = JSON.parse(readFileSync(wrongSession.path, 'utf8'));
    payload.sessionId = 'invalid';
    writeFileSync(wrongSession.path, JSON.stringify(payload));
    assert.throws(() => consumeRoutingHandoff({ env: { OWENLOOP_ROUTING_HANDOFF: wrongSession.path }, origin,
      target: { workflow: 'wf', run: 'session' }, kind: 'agent-run', now: () => now }), /refused/);
    assert.equal(existsSync(wrongSession.path), false);
    wrongSession.terminal();

    const wrongRoot = handoff('root');
    const rootPayload = JSON.parse(readFileSync(wrongRoot.path, 'utf8'));
    rootPayload.workRoot = 'relative/work';
    writeFileSync(wrongRoot.path, JSON.stringify(rootPayload));
    assert.throws(() => consumeRoutingHandoff({ env: { OWENLOOP_ROUTING_HANDOFF: wrongRoot.path }, origin,
      target: { workflow: 'wf', run: 'root' }, kind: 'agent-run', now: () => now }), /refused/);
    assert.equal(existsSync(wrongRoot.path), false);
    wrongRoot.terminal();

    const legacyCredential = handoff('legacy');
    const legacyPayload = JSON.parse(readFileSync(legacyCredential.path, 'utf8'));
    legacyPayload.credential = credential;
    writeFileSync(legacyCredential.path, JSON.stringify(legacyPayload));
    assert.throws(() => consumeRoutingHandoff({ env: { OWENLOOP_ROUTING_HANDOFF: legacyCredential.path }, origin,
      target: { workflow: 'wf', run: 'legacy' }, kind: 'agent-run', now: () => now }), /refused/);
    legacyCredential.terminal();

    const stale = handoff('stale');
    now = 121_001;
    assert.throws(() => consumeRoutingHandoff({ env: { OWENLOOP_ROUTING_HANDOFF: stale.path }, origin,
      target: { workflow: 'wf', run: 'stale' }, kind: 'agent-run', now: () => now }), /refused/);
    assert.equal(existsSync(stale.path), false);
    stale.terminal();
    await session.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('willing tuples require exact cached org, account, crew, serving crew and local availability', () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-roster-'));
  try {
    const env = { HOME: root };
    writeHubRosterCache(env, { version: 1, origin, orgId: 'org', orgName: 'Org', account: 'default', fetchedAt: 1000,
      global: {}, crews: [{ crewId: 'crew-id', crewName: 'build-crew', roster: { build: [
	{ harness: 'codex', model: 'approved-model', effort: 'high' },
      ] } }],
    });
    const tuple = { id: 'tuple', harness: 'codex', model: 'approved-model', effort: 'high' as const };
    const candidate: RoutingOfferCandidate = { candidateId: 'candidate', frameId: 'wf', step: 'builder', key: '',
      evidenceGeneration: 'generation', role: 'implementation',
      context: { now: 1000, maxTtlMs: 300_000, orgId: 'org', principalId: 'actor', sessionId,
	shiftId: 'shf_service', runId: 'wf', crewId: 'crew-id', capability: 'build',
	rosterRevision: 'roster', rolePolicyRevision: 'policy' },
      rolePolicy: { revision: 'policy', unknownRole: 'refuse', rules: [{ model: tuple.model, roles: ['implementation'] }] },
      tuples: [{ tuple, eligible: true, available: true }],
    };
    const select = (c: RoutingOfferCandidate, over: Partial<Parameters<typeof selectLocalRoutingTuples>[1]> = {}) =>
      selectLocalRoutingTuples(c, { env, origin, account: 'default', serving: ['build-crew'],
	harnessAvailable: () => true, ...over });
    assert.deepEqual(select(candidate), candidate.tuples);
    assert.deepEqual(select(candidate, { account: 'other' }), []);
    assert.deepEqual(select(candidate, { serving: ['other-crew'] }), []);
    assert.deepEqual(select(candidate, { harnessAvailable: () => false }), []);
    assert.deepEqual(select({ ...candidate, context: { ...candidate.context, orgId: 'other' } }), []);
    assert.deepEqual(select({ ...candidate, context: { ...candidate.context, crewId: 'other' } }), []);
    assert.deepEqual(select({ ...candidate, context: { ...candidate.context, rolePolicyRevision: 'revoked' } }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
