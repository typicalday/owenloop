/**
 * REAL-child e2e for `owenloop work hold --mcp` (plan test 4): spawns the actual
 * `bin/owenloop.mjs` over real stdio against a `node:http` mock hub and drills
 * the born-bound work-holder on the wire — heartbeats from birth, get_order,
 * the closing submit whose response frame must NOT race process exit (reviewer
 * error 1), post-terminal fast-fails with no hub traffic (reviewer error 2),
 * the SIGTERM-pre-submit final breath, and the --mcp/--ignore-stdin usage
 * error.
 *
 * `pretest` builds `dist/`, so the bin shim resolves for the children.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { installSignedBundleFixture, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { callTool, handshake, spawnMcp, startMockHub, until, type HubReq, type McpChild } from './helpers/mcp-stdio-client.ts';
import { installHolderDefinition, makeHolderStoreWritable } from './helpers/holder-definition.ts';

const TOKEN = 'tok-e2e';

let configDir: string;
beforeEach(async () => {
  // Isolate settings: a temp HOME means the child sees NO settings
  // file — origin comes only from --origin, token only from OWENLOOP_TOKEN.
  configDir = mkdtempSync(join(tmpdir(), 'owenloop-hold-e2e-'));
  ORDER_PACKET.defDigest = await installHolderDefinition(configDir);
});
afterEach(() => {
  makeHolderStoreWritable(configDir);
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function childEnv(): Record<string, string | undefined> {
  return { OWENLOOP_TOKEN: TOKEN, HOME: configDir, OWENLOOP_CONFIG_DIR: undefined, OWENLOOP_SESSION: '',
    OWENLOOP_INSTRUCTION_CWD: join(configDir, 'untrusted-ambient-location') };
}

function of(reqs: HubReq[], verb: string): HubReq[] {
  return reqs.filter((r) => r.verb === verb);
}

const ORDER_PACKET = {
  run: 'run1',
  workflow: 'wf1',
  step: 'builder',
  key: '',
  defDigest: '',
  inputs: [],
  outputs: ['pr'],
  prompt: 'do the thing',
  consumes: {},
  owes: [],
};

/** Canned hub: healthy lease, green closing submit. */
function hubScript(verb: string): unknown {
  switch (verb) {
    case 'get_order':
      return { text: 'here', workflow: 'wf1', run: 'run1', order: ORDER_PACKET, lease: { claimed: true } };
    case 'heartbeat':
      return { text: 'hb' };
    case 'release':
      return { text: 'released', released: true };
    case 'submit':
      return { text: 'ok', outcome: 'green', closed: true };
    default:
      return { text: '' };
  }
}

function spawnHold(origin: string, extra: string[] = [], cwd?: string): McpChild {
  return spawnMcp(
    ['hold', '--order', 'wf1/run1', '--origin', origin, '--heartbeat-interval', '25', '--mcp', ...extra],
    childEnv(),
    cwd,
  );
}

test('hold --mcp full lifecycle on the wire: heartbeats from birth, closing submit answers, then fast-fails until stdin EOF (reviewer errors 1+2)', async () => {
  const { origin, reqs, server } = await startMockHub(hubScript);
  const mcp = spawnHold(origin);
  try {
    const init = await handshake(mcp);
    assert.equal(init.result.serverInfo.name, 'owenloop-hold');

    const list = await mcp.request('tools/list');
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(names, ['ask', 'get_order', 'put_file_artifact', 'reject', 'submit']);

    // Heartbeats from BIRTH: the lease loop runs under the mount with zero
    // tool calls issued — first contact plus renewals appear on the wire.
    await until(() => of(reqs, 'heartbeat').length >= 2, 'heartbeats from birth');
    assert.ok(of(reqs, 'get_order').length >= 1, 'the loop made first contact');
    assert.equal(reqs[0]!.auth, `Bearer ${TOKEN}`, 'the token rode as a Bearer header');

    // The tool live-fetches the packet for the BOUND run — no ids from the model.
    const got = await callTool(mcp, 'get_order');
    assert.equal(got.isError, false);
    assert.equal(got.body.workflow, 'wf1');
    assert.equal(got.body.order.step, 'builder');
    assert.equal(got.body.order.prompt, undefined, 'hub prompt text is not locally verified');
    assert.match(mcp.stderr(), /defPolicy=warn allows agent execution/, 'unsigned local definition retains the default warning policy');

    // THE error-1 regression: the closing submit terminates the lease loop, but
    // its own response frame must still arrive intact — the process may not
    // exit until the transport (stdin) ends.
    const sub = await callTool(mcp, 'submit', { path: 'pr', value: { url: 'x' }, done: true });
    assert.equal(sub.isError, false, `closing submit answered normally, got: ${JSON.stringify(sub.body)}`);
    assert.equal(sub.body.outcome, 'green');
    assert.equal(sub.body.closed, true);

    // THE error-2 regression, on the wire: once the hold is terminal, both
    // tools fast-fail with isError and make NO hub call. The loop settles a
    // beat after the submit, so poll to the guard first.
    await until(
      () => of(reqs, 'submit').length === 1,
      'exactly one submit on the wire',
    );
    let guard = await callTool(mcp, 'get_order');
    while (!guard.isError) guard = await callTool(mcp, 'get_order');
    assert.match(guard.body.error, /no longer held/);

    const before = reqs.length;
    const g = await callTool(mcp, 'get_order');
    assert.equal(g.isError, true);
    assert.match(g.body.error, /no longer held/);
    const s = await callTool(mcp, 'submit', { path: 'pr', value: 2 });
    assert.equal(s.isError, true);
    assert.match(s.body.error, /no longer held/);
    assert.equal(reqs.length, before, 'terminal fast-fails made no hub calls');
    assert.equal(of(reqs, 'release').length, 0, 'a closed run is not released — the claim is already gone');

    // Transport EOF is the exit condition; the completed hold exits 0.
    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `exit 0, stderr:\n${mcp.stderr()}`);
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
  }
});

test('standalone hold --mcp refuses a model order when its local definition is absent', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'owenloop-hold-empty-home-'));
  const { origin, server } = await startMockHub(hubScript);
  const mcp = spawnMcp(
    ['hold', '--order', 'wf1/run1', '--origin', origin, '--mcp'],
    { OWENLOOP_TOKEN: TOKEN, HOME: emptyHome, OWENLOOP_CONFIG_DIR: undefined },
    emptyHome,
  );
  try {
    await handshake(mcp);
    const shown = await callTool(mcp, 'get_order');
    assert.equal(shown.isError, true);
    assert.match(shown.body.error, /model order refusal: local definition unavailable/);
    assert.doesNotMatch(JSON.stringify(shown.body), /"path":"pr"/);
    mcp.endStdin();
    await mcp.exited;
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('hold --mcp restricted selector registers exactly get_order and submit on tools/list', async () => {
  const { origin, server } = await startMockHub(hubScript);
  const mcp = spawnHold(origin, ['--mcp-tools=get_order,submit']);
  try {
    await handshake(mcp);
    const list = await mcp.request('tools/list');
    const names = (list.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    assert.deepEqual(names, ['get_order', 'submit']);

    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `exit 0, stderr:\n${mcp.stderr()}`);
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
  }
});

test('hold --mcp submits a large parsed valueFile from its cwd without echoing payload bytes through MCP', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'owenloop-hold-mcp-run-'));
  const payload = 'p'.repeat(1024 * 1024);
  writeFileSync(join(workdir, 'artifact.json'), JSON.stringify({ kind: 'large-artifact', payload }), 'utf8');
  const { origin, reqs, server } = await startMockHub(hubScript);
  const mcp = spawnHold(origin, [], workdir);
  try {
    await handshake(mcp);
    const sub = await callTool(mcp, 'submit', { path: 'pr', valueFile: 'artifact.json', done: true });
    assert.equal(sub.isError, false, 'file submit answered normally: ' + JSON.stringify(sub.body));
    assert.equal(sub.body.outcome, 'green');
    assert.equal(JSON.stringify(sub.frame).includes(payload), false, 'the MCP response does not duplicate the file payload');

    await until(() => of(reqs, 'submit').length === 1, 'file-form submit on the wire');
    const body = of(reqs, 'submit')[0]!.body;
    assert.deepEqual(body?.['value'], { kind: 'large-artifact', payload });
    assert.equal('valueFile' in (body ?? {}), false, 'the hub receives the unchanged submit request shape');

    mcp.endStdin();
    assert.equal(await mcp.exited, 0, 'exit 0, stderr:\n' + mcp.stderr());
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('hold --mcp refuses an existing valueFile outside its cwd without submitting', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'owenloop-hold-mcp-run-'));
  const outside = join(tmpdir(), 'owenloop-hold-mcp-outside-' + Date.now() + '.json');
  writeFileSync(outside, JSON.stringify({ private: true }), 'utf8');
  const { origin, reqs, server } = await startMockHub(hubScript);
  const mcp = spawnHold(origin, [], workdir);
  try {
    await handshake(mcp);
    const sub = await callTool(mcp, 'submit', { path: 'pr', valueFile: outside, done: true });
    assert.equal(sub.isError, true);
    assert.match(sub.body.error, /submit-value-file-outside-workdir/);
    assert.equal(of(reqs, 'submit').length, 0);

    mcp.endStdin();
    assert.equal(await mcp.exited, 0, 'exit 0, stderr:\n' + mcp.stderr());
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
    rmSync(workdir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('hold --mcp on SIGTERM before any submit: releases on the wire, never submits, exits 0 at stdin EOF', async () => {
  const { origin, reqs, server } = await startMockHub(hubScript);
  const mcp = spawnHold(origin);
  try {
    await handshake(mcp);
    await until(() => of(reqs, 'heartbeat').length >= 1, 'first heartbeat');

    mcp.child.kill('SIGTERM');
    // The final breath: a targeted release rides the wire so the order
    // re-offers immediately instead of stranding until lease expiry.
    await until(() => of(reqs, 'release').length >= 1, 'release after SIGTERM');
    assert.deepEqual(of(reqs, 'release')[0]!.body, { workflow: 'wf1', run: 'run1', reason: 'signal' });
    assert.equal(of(reqs, 'submit').length, 0, 'nothing was submitted');

    // The signal stops the LOOP, not the transport: the server keeps serving
    // fast-fails until the parent closes the pipe.
    const g = await callTool(mcp, 'get_order');
    assert.equal(g.isError, true);
    assert.match(g.body.error, /no longer held/);

    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `released outcome exits 0, stderr:\n${mcp.stderr()}`);
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
  }
});

test('hold --mcp --ignore-stdin is a usage error (exit 2) — stdin IS the transport', async () => {
  const mcp = spawnMcp(['hold', '--order', 'wf1/run1', '--mcp', '--ignore-stdin'], childEnv());
  try {
    assert.equal(await mcp.exited, 2);
    assert.match(mcp.stderr(), /mutually exclusive/);
  } finally {
    mcp.child.kill('SIGKILL');
  }
});

// Local signed test publication and loopback TLS only. This verifies the normal
// production role wiring; it is not hosted Delivery acceptance evidence.
for (const mode of ['absent', 'supplied', 'workdir', 'child', 'feedback', 'routing', 'overlap', 'cancelled', 'verified-absent', 'verified-supplied', 'verified-overlap', 'verified-child', 'verified-workdir', 'verified-stalled-private-initial', 'verified-stalled-private-final', 'lease-stalled-first-contact', 'lease-stalled-heartbeat'] as const) {
test(`normal hold --mcp independently verifies ${mode} input witnesses over HTTPS`, async () => {
  const verified = mode.startsWith('verified-');
  const supplied = mode === 'supplied' || mode === 'verified-supplied';
  const workdirInput = mode === 'workdir' || mode === 'verified-workdir';
  const feedback = mode === 'feedback';
  const routing = mode === 'routing';
  const emptyInputs = feedback || routing;
  const canonicalWorkflow = (mode === 'child' || mode === 'verified-child') ? 'wf_child' : 'wf1';
  const sourceDir = writeBundleSource({ name: 'optional-holder', workflow: `name: optional-holder
inputs:
${emptyInputs ? '  []' : workdirInput ? `  - name: config
    seedOwed: true` : `
  - name: proposal
    seedOwed: true
  - name: optional
    seedOwed: ${supplied}`}
steps:
  - name: planner
    consumes: ${emptyInputs ? '[]' : workdirInput ? '[]\n    workdirFrom: config.path' : '[proposal, optional]'}
    produces: [plan]
    terminal: true
    body: "Produce plan."
` });
  let server: ReturnType<typeof createServer> | undefined;
  let mcp: McpChild | undefined;
  try {
    const installed = await installSignedBundleFixture({ sourceDir,
      root: join(configDir, '.owenloop', 'workflows'), home: configDir });
    const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
    const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name)!;
    const key = join(configDir, 'tls.key');
    const cert = join(configDir, 'tls.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert],
    { stdio: 'ignore' });
    const consumes: Record<string, unknown> = workdirInput || emptyInputs ? {}
      : { proposal: 'a local test proposal', ...(supplied ? { optional: 'supplied required input' } : {}) };
    const packet = { workflow: canonicalWorkflow, run: 'run1', step: 'planner', key: '',
      defDigest: defInstructionDigest(definition), inputs: workdirInput || emptyInputs ? [] : ['proposal', 'optional'], outputs: ['plan'],
      consumes,
      consumedFingerprint: workdirInput || emptyInputs ? {} : { proposal: 1, optional: 1 },
      ...(workdirInput ? { workdir: configDir } : {}),
      // Synthetic unsupported sidecar; no native routing authority is claimed.
      ...(routing ? { routing: {} } : {}),
      owes: [{ path: 'plan', version: 1, reasons: [], judgmentRejects: feedback ? 1 : 0, schemaRejects: 0 }] };
    const seen: string[] = [];
    let witnessAvailable = true;
    let witnessWorkflow = canonicalWorkflow;
    let workdirVersion = 1;
    let privateReads = 0;
    let privateTransportClosed = false;
    let privateReadEntered!: () => void;
    let releasePrivateRead!: () => void;
    const privatePaused = new Promise<void>(resolve => { privateReadEntered = resolve; });
    const privateResume = new Promise<void>(resolve => { releasePrivateRead = resolve; });
    let witnessReads = 0;
    let pauseNextWitness = false;
    let firstWitnessEntered!: () => void;
    let releaseFirstWitness!: () => void;
    const firstWitnessPaused = new Promise<void>(resolve => { firstWitnessEntered = resolve; });
    const firstWitnessResume = new Promise<void>(resolve => { releaseFirstWitness = resolve; });
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      seen.push(req.url!);
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.workflow, 'wf1');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (req.url === '/api/reference_order/v2') {
	assert.deepEqual(body, { workflow: 'wf1', run: 'run1' });
	if (emptyInputs) {
	  res.end(JSON.stringify({ protocol: 'trusted-reference-read-v2', state: routing ? 'routing-unsupported' : 'unsupported-feedback', workflow: 'wf1', run: 'run1' }));
	  return;
	}
	const availableAtRead = witnessAvailable;
	if (((mode === 'overlap' || mode === 'cancelled') && ++witnessReads === 1) || pauseNextWitness) {
	  pauseNextWitness = false;
	  firstWitnessEntered();
	  await firstWitnessResume;
	}
	res.end(JSON.stringify(availableAtRead ? {
	  protocol: 'trusted-reference-read-v2', state: 'available', workflow: witnessWorkflow, run: 'run1',
	  order: { ...packet, workflow: witnessWorkflow, owes: [{ path: 'plan', version: 1 }] }, inputs: workdirInput || emptyInputs ? [] : [
	    { path: 'proposal', version: 1, present: true, value: packet.consumes.proposal },
	    { path: 'optional', version: 1, present: supplied,
	      ...(supplied ? { value: packet.consumes.optional } : {}) },
	  ], ...(workdirInput ? { workdirInput: { stem: 'config', version: workdirVersion, value: { path: configDir } } } : {}),
	  lease: { claimed: true },
	} : { protocol: 'trusted-reference-read-v2', state: 'unavailable', workflow: 'wf1', run: 'run1' }));
      } else if (req.url === '/api/heartbeat' && mode === 'lease-stalled-heartbeat') {
	res.once('close', () => { if (!res.writableEnded) privateTransportClosed = true; });
	privateReadEntered();await privateResume;
	res.end(JSON.stringify({ text: '' }));
      } else if (req.url === '/api/get_order') {
	privateReads++;
	if ((mode === 'lease-stalled-first-contact' && privateReads === 1)
	  || (mode === 'verified-stalled-private-initial' && privateReads === 2)
	  || (mode === 'verified-stalled-private-final' && privateReads === 3)) {
	  res.once('close', () => { if (!res.writableEnded) privateTransportClosed = true; });
	  privateReadEntered();
	  await privateResume;
	}
	res.end(JSON.stringify({ text: '', workflow: canonicalWorkflow, run: 'run1', order: packet, lease: { claimed: true } }));
      } else if (req.url === '/api/release') res.end(JSON.stringify({ text: '', released: true }));
      else res.end(JSON.stringify({ text: '' }));
    });
    await new Promise<void>(resolve => server!.listen(0, 'localhost', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    mcp = spawnMcp(['hold', '--order', 'wf1/run1', '--origin', `https://localhost:${address.port}`,
      '--heartbeat-interval', '25', '--mcp', ...(verified ? ['--verified-hosted'] : [])], { ...childEnv(), ...installed.env, NODE_EXTRA_CA_CERTS: cert });
    await handshake(mcp);
    if (mode === 'lease-stalled-first-contact' || mode === 'lease-stalled-heartbeat') {
      await privatePaused;
      mcp.endStdin();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
	const outcome = await Promise.race([mcp.exited, new Promise<'pending'>(resolve => {
	  timer = setTimeout(() => resolve('pending'), 2_000);
	})]);
	assert.equal(outcome, 0, 'EOF exits while lease contact is stalled');
	await until(() => privateTransportClosed, 'EOF aborts lease HTTPS request', 1_000);
      } finally { clearTimeout(timer);releasePrivateRead();await mcp.exited; }
      assert.equal(seen.filter(path => path === '/api/get_order').length, 1);
      assert.equal(seen.filter(path => path === '/api/heartbeat').length, mode === 'lease-stalled-heartbeat' ? 1 : 0);
      assert.equal(seen.filter(path => path === '/api/release').length, mode === 'lease-stalled-heartbeat' ? 1 : 0);
      assert.equal(seen.some(path => ['/api/submit', '/api/ask', '/api/reject'].includes(path)), false);
      return;
    }
    if (mode === 'cancelled') {
      const requestId = mcp.fireRequest('tools/call', { name: 'ask',
	arguments: { path: 'plan', question: 'local cancellation boundary test' } });
      await firstWitnessPaused;
      mcp.notify('notifications/cancelled', { requestId });
      await mcp.request('ping'); // The notification has been processed before the witness resumes.
      releaseFirstWitness();
      mcp.endStdin();
      assert.equal(await mcp.exited, 0);
      assert.equal(mcp.frames.some(frame => frame.id === requestId), false, 'cancelled response stays suppressed');
      assert.equal(seen.includes('/api/ask'), false, 'cancelled request must not send a later consequence');
      assert.equal(seen.includes('/api/submit'), false);
      return;
    }
    if (mode === 'overlap') {
      const older = callTool(mcp, 'get_order');
      await firstWitnessPaused;
      witnessAvailable = false;
      const newer = await callTool(mcp, 'get_order');
      assert.equal(newer.isError, true);
      assert.match(newer.body.error, /service-unavailable/);
      releaseFirstWitness();
      const late = await older;
      assert.equal(late.isError, true, 'delayed old HTTPS response cannot undo newer refusal');
      assert.match(late.body.error, /superseded.*refusal/);
      assert.equal(seen.some(path => ['/api/submit', '/api/ask', '/api/reject'].includes(path)), false);
      mcp.endStdin();
      assert.equal(await mcp.exited, 0);
      return;
    }
    if (mode === 'verified-stalled-private-initial' || mode === 'verified-stalled-private-final') {
      const pending = callTool(mcp, 'get_order');
      await privatePaused;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
	const result = await Promise.race([pending, new Promise<'still-pending'>(resolve => {
	  timer = setTimeout(() => resolve('still-pending'), 6_000);
	})]);
	assert.notEqual(result, 'still-pending', 'actual verified CLI must bound its private holder reads');
	if (result !== 'still-pending') {
	  assert.equal(result.isError, true);
	  assert.match(JSON.stringify(result.body), /claim-observation-expired/);
	  await until(() => privateTransportClosed, 'expired private HTTPS transport closes', 1_000);
	  assert.equal((await callTool(mcp, 'get_order')).isError, false, 'healthy sibling succeeds while old private read is stalled');
	}
      } finally {
	clearTimeout(timer);releasePrivateRead();await pending;
      }
      assert.equal((await callTool(mcp, 'get_order')).isError, false, 'late completion cannot erase fresh state');
      assert.equal(seen.some(path => ['/api/submit', '/api/submit/conditional-v1', '/api/ask', '/api/reject'].includes(path)), false);
      assert.equal(seen.includes('/api/reference_order/v1'), false);
      mcp.endStdin();
      assert.equal(await mcp.exited, 0);
      return;
    }
    const viewed = await callTool(mcp, 'get_order');
    if (verified) {
      assert.equal(viewed.isError, false, JSON.stringify(viewed.body));
      assert.equal(viewed.body.state, 'ready');
      assert.equal(viewed.body.serviceObservation.referenceProtocol, 'trusted-reference-read-v2');
      assert.deepEqual(viewed.body.inputWitnesses, workdirInput ? [] : [
	{ path: 'proposal', version: 1, present: true, trust: 'trusted-service-claim-version' },
	{ path: 'optional', version: 1, present: supplied, trust: 'trusted-service-claim-version' },
      ]);
      assert.deepEqual(viewed.body.consumes.map((input: { path: string; value: unknown }) => [input.path, input.value]),
	Object.entries(packet.consumes));
      assert.equal(seen.includes('/api/reference_order/v1'), false, 'v2 must not downgrade to v1');
      if (mode === 'verified-overlap') {
	pauseNextWitness = true;
	const older = callTool(mcp, 'get_order');
	await firstWitnessPaused;
	const newer = await callTool(mcp, 'get_order');
	releaseFirstWitness();
	const late = await older;
	assert.equal(newer.isError, false, JSON.stringify(newer.body));
	assert.equal(late.isError, false, JSON.stringify(late.body));
      }
      if (mode === 'verified-workdir') {
	assert.deepEqual(viewed.body.consumes, []);
	workdirVersion++;
	const moved = await callTool(mcp, 'get_order');
	assert.equal(moved.isError, true, 'same cwd value at a new source version must refuse');
	workdirVersion--;
	assert.equal((await callTool(mcp, 'get_order')).isError, false, 'fresh original workdir witness recovers');
      }
      if (mode === 'verified-child') {
	assert.equal(viewed.body.serviceObservation.workflow, 'wf_child');
	witnessWorkflow = 'wf_changed_child';
	const moved = await callTool(mcp, 'get_order');
	assert.equal(moved.isError, true, 'a newer independent child identity cannot replace the pinned child');
	assert.doesNotMatch(JSON.stringify(moved.body), /a local test proposal/);
	witnessWorkflow = canonicalWorkflow;
	assert.equal((await callTool(mcp, 'get_order')).isError, false, 'fresh verification of the original child recovers');
      }
      witnessAvailable = false;
      const refused = await callTool(mcp, 'get_order');
      assert.equal(refused.isError, true);
      assert.doesNotMatch(JSON.stringify(refused.body), /a local test proposal|supplied required input/);
      assert.equal(seen.some(path => ['/api/submit', '/api/submit/conditional-v1', '/api/ask', '/api/reject'].includes(path)), false);
      mcp.endStdin();
      assert.equal(await mcp.exited, 0);
      return;
    }
    if (emptyInputs) {
      assert.equal(viewed.isError, true, 'normal zero-input holder must refuse unsupported dynamic state');
      assert.match(viewed.body.error, routing ? /service-routing-unsupported/ : /service-unsupported-feedback/);
      for (const [name, args] of [['submit', { path: 'plan', value: {} }], ['ask', { path: 'plan', question: 'why' }], ['reject', { path: 'plan', text: 'retry' }]] as const) {
	assert.equal((await callTool(mcp, name, args)).isError, true);
      }
      assert.ok(seen.includes('/api/reference_order/v2'));
      assert.equal(seen.some(path => ['/api/submit', '/api/ask', '/api/reject'].includes(path)), false);
      mcp.endStdin();
      assert.equal(await mcp.exited, 0);
      return;
    }
    assert.equal(viewed.isError, false, mcp.stderr());
    assert.equal(viewed.body.order.workflow, canonicalWorkflow);
    assert.deepEqual(viewed.body.order.consumes, packet.consumes);
    if (workdirInput) assert.deepEqual(viewed.body.order.inputWitnesses, []);
    else assert.equal(viewed.body.order.inputWitnesses.find((w: { path: string }) => w.path === 'optional').present, supplied);
    assert.ok(seen.includes('/api/reference_order/v2'), 'normal mode must use the independent service witness');
    if (mode === 'child') {
      witnessWorkflow = 'wf_changed';
      const moved = await callTool(mcp, 'get_order');
      assert.equal(moved.isError, true);
      const refusedWrite = await callTool(mcp, 'ask', { path: 'plan', question: 'changed child control' });
      assert.equal(refusedWrite.isError, true);
      assert.equal(seen.includes('/api/ask'), false);
      witnessWorkflow = canonicalWorkflow;
    }
    witnessAvailable = false;
    const rejected = workdirInput
      ? await callTool(mcp, 'ask', { path: 'plan', question: 'local boundary test' })
      : await callTool(mcp, 'reject', { path: 'proposal', text: 'local boundary test' });
    assert.equal(rejected.isError, true);
    assert.match(rejected.body.error, /service-unavailable/);
    assert.equal(seen.includes('/api/reject'), false);
    assert.equal(seen.includes('/api/ask'), false);
    mcp.endStdin();
    assert.equal(await mcp.exited, 0);
  } finally {
    if (mcp?.child.exitCode === null) { mcp.endStdin(); await mcp.exited; }
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    rmSync(sourceDir, { recursive: true, force: true });
  }
});
}
