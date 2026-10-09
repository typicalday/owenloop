import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { packBundle } from '../../../src/bundle/index.ts';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { DSSE_SSH_NAMESPACE, dsseSignPublication } from '../../../src/crypto/dsse.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { createSshSigner } from '../../../src/crypto/ssh.ts';
import { canonicalJsonBytes } from '../../../src/install.ts';
import type { DecisionBindingV1, ReferenceRouting, WorkOrder } from '../src/hub/types.ts';
import type { RoutingHandoffV1 } from '../src/shift/runtime.ts';
import { stageRoutedDefinition } from '../src/shift/routing-definition-stage.ts';
import { prepareRoutedCommandRunner } from '../src/roles/routing-command-runner.ts';

const rootWorkflow = 'root', frameWorkflow = 'wf_child_instance';
const definitionName = 'routing/child', run = 'native-run';
const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';

async function fixture(options: { claimFrame?: string; inputMismatch?: boolean;
  postrunClaim?: 'closed' | 'held'; command?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ol-routed-command-role-'));
  chmodSync(root, 0o700);
  const home = join(root, 'operator-home'), stateDir = join(root, 'state');
  const workRoot = join(root, 'work'), bundle = join(root, 'bundle');
  for (const dir of [home, stateDir, workRoot, bundle]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(bundle, 'bundle.yaml'), [
    'formatVersion: 2', 'package:', '  name: routing', '  version: 1.0.0',
    'workflows:', `  "${definitionName}": child.yaml`, `default: "${definitionName}"`,
    'platforms: []', 'integrity:', '  algorithm: sha256', '  files: {}',
    'capabilities: {}', 'lock: {}', '',
  ].join('\n'));
  const command = options.command ?? 'printf x >> started.txt; printf live > live.txt; printf \'{"result":"ok"}\' > "$OWENLOOP_PAYLOAD_FILE"';
  writeFileSync(join(bundle, 'child.yaml'), [
    `name: ${definitionName}`, 'inputs: []', 'steps:', '  - name: build',
    '    executor: command', '    consumes: []', '    produces: [out]',
    '    terminal: true', `    command: ${command}`, '',
  ].join('\n'));
  const packed = packBundle(bundle);
  const keyPath = join(home, 'publisher');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'ignore' });
  const publicKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  const config = join(home, '.owenloop');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'allowed_signers'),
    `publisher ${publicKey.openSshPublicKey}\n`, { mode: 0o600 });
  const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: keyPath });
  const publication = canonicalJsonBytes((await dsseSignPublication(Buffer.from(canonicalJsonBytes({
    digest: packed.digest, name: packed.manifest.package.name,
    version: packed.manifest.package.version, publisherKeyId: publicKey.keyid, timestamp: Date.now(),
  })), signer)).envelope);
  const now = Date.now();
  const binding: DecisionBindingV1 = { orgId: 'org', runId: rootWorkflow, frameId: frameWorkflow,
    def: { bundleDigest: `sha256:${packed.digest}` as const, workflowName: definitionName },
    subjectKey: 'subject', evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates',
    policyDigest: 'sha256:policy', revisions: { definition: '1', candidates: '1', policy: '1',
      authority: '1', rolePolicy: '1', roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
    issuedAt: now - 1_000, expiresAt: now + 90_000,
    authority: { principalId: 'agent', sessionId } };
  const claimBinding = { ...binding, frameId: options.claimFrame ?? frameWorkflow };
  const routing: ReferenceRouting = { claim: { state: 'claimed', claimId: run, decisionId: 'decision', binding: claimBinding,
    invocationId: null, orderId: run, attemptId: 'attempt', principalId: 'agent',
    sessionId, shiftId: 'shf_service' },
  decision: { decisionId: 'decision', binding: claimBinding, status: 'applied', applied: null, effect: null },
  preference: { offer: null, tuples: [], role: 'implementation', rolePolicy: null,
    rosterRevision: 'a'.repeat(64), expiresAt: now + 60_000 } };
  const native: WorkOrder = { workflow: frameWorkflow, run, step: 'build', worker: 'command',
    defDigest: packed.digest, consumes: {}, expected_outputs: [], feedback: [], advisory: {},
    submit_hint: '', routing: { ...routing, claim: { ...routing.claim, binding },
      decision: { ...routing.decision, binding } } };
  const stage = await stageRoutedDefinition({ order: native, rootWorkflow,
    origin: 'https://hub.example.test', token: 'fixture-secret', stateDir, workRoot,
    sourceEnv: { HOME: home }, beforeRequest: () => {}, onRateLimit: () => {},
    stillAuthorized: () => true,
    fetchImpl: (async input => {
      const path = new URL(String(input)).pathname;
      if (path === `/api/bundles/${packed.digest}`) return new Response(packed.bytes, { status: 200 });
      if (path === `/api/publications/${packed.digest}`) return new Response(publication,
	{ status: 200, headers: { 'x-owenloop-publication-state': 'signed' } });
      if (path === `/api/origins/${packed.digest}`) return new Response(null, { status: 404 });
      throw new Error('unexpected fixture fetch');
    }) as typeof fetch });
  const order = { workflow: frameWorkflow, run, step: 'build', key: '',
    defDigest: packed.digest, worker: 'command', inputs: [], outputs: ['out'], consumes: {},
    consumedFingerprint: {}, owes: [{ path: 'out', version: 1, judgmentRejects: 0,
      schemaRejects: 0, reasons: [] }], routing };
  const direct = { ...order, owes: [{ path: 'out', version: 1 }] };
  const referenceBinding = { rootWorkflow, frameWorkflow, run, claimId: run,
    decisionId: 'decision', sessionId, shiftId: 'shf_service',
    orderDigest: 'b'.repeat(64), authorityRevision: 'c'.repeat(64),
    rosterRevision: routing.preference.rosterRevision,
    routingDigest: options.inputMismatch ? 'e'.repeat(64) : valueDigestHex(routing),
    preferenceExpiresAt: routing.preference.expiresAt };
  const reference = { protocol: 'trusted-routed-reference-read-v2', state: 'available',
    workflow: rootWorkflow, run, order: direct, inputs: [], lease: { claimed: true },
    binding: referenceBinding };
  const claim = { protocol: 'routing-claim-read-v2', state: 'available',
    workflow: rootWorkflow, run, routing, binding: referenceBinding };
  const socketDir = join(root, 'ol-rb-ABCDEF');
  mkdirSync(socketDir, { mode: 0o700 });
  const socketPath = join(socketDir, 'broker.sock');
  const events: string[] = [];
  const errors: string[] = [];
  const server: Server = createServer(socket => {
    let text = '';
    socket.on('data', chunk => {
      text += chunk.toString();
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(text.slice(0, newline)) as { method: string; body: Record<string, unknown> };
      events.push(request.method);
      let value: unknown;
      switch (request.method) {
	case 'read_routing_claim': value = { routing, freshness: 'fresh-at-read', atomicLaunch: false }; break;
	case 'get_order':
	case 'get_launch_order': value = { text: '', workflow: frameWorkflow, run,
	  order, lease: { claimed: true } }; break;
	case 'heartbeat': value = { text: '' }; break;
	case 'read_routed_reference_v2': value = reference; break;
	case 'read_routing_claim_v2': value = claim; break;
	case 'reserve_launch': value = { reservationId: 'lr-one', orderId: run, expiresAt: now + 50_000 }; break;
	case 'report_launch': value = { orderId: run, digest: valueDigestHex(request.body.report),
	  recordedAt: now, provenance: 'authenticated-worker-report' }; break;
	case 'quiesce': value = { quiescing: true, effects: 'settled' }; break;
	case 'command_postrun': {
	  const receipt = request.body.receipt as Record<string, unknown>;
	  assert.equal(receipt.command, command);
	  assert.equal(receipt.exitCode, 0);
	  assert.deepEqual(receipt.payload, { result: 'ok' });
	  assert.equal(readFileSync(join(workRoot, rootWorkflow, run, 'started.txt'), 'utf8'), 'x');
	  assert.equal(readFileSync(join(workRoot, rootWorkflow, run, 'live.txt'), 'utf8'), 'live');
	  value = { outcome: 'submitted', claim: options.postrunClaim ?? 'closed' };
	  break;
	}
	case 'command_finish': value = { state: 'released' }; break;
	default: throw new Error(`unexpected fixture broker method ${request.method}`);
      }
      socket.end(JSON.stringify({ ok: true, value }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const handoff = { version: 'routing-handoff-v1', incarnation: `inc_${'a'.repeat(32)}`,
    nonce: 'b'.repeat(32), origin: 'https://hub.example.test', orgId: 'org',
    sessionId, shiftId: 'shf_service', broker: { socketPath, cap: 'd'.repeat(64) },
    definitionStage: { path: stage.path, digest: stage.digest }, workRoot,
    reservation: { recordType: 'reservation', workflow: rootWorkflow, run,
      childKind: 'exec', token: 'f'.repeat(32), reservedAt: now },
    createdAt: now, expiresAt: now + 120_000, sessionExpiresAt: now + 900_000 } as RoutingHandoffV1;
  return { root, stage, server, handoff, events, errors, order };
}

test('real routed command composition executes signed nested frame in writable cwd and sends one parent postrun', async () => {
  const f = await fixture();
  try {
    const ambient = { HOME: '/operator/home', OWENLOOP_TOKEN: 'operator-secret',
      OWENLOOP_ACCOUNT: 'operator', OWENLOOP_ALLOWED_WORKDIR_ROOTS: join(f.root, 'work'),
      PATH: process.env.PATH };
    const prepared = await prepareRoutedCommandRunner({ handoff: f.handoff,
      originalEnv: ambient, out: () => {}, err: line => f.errors.push(line) });
    assert.equal(await prepared.run(), 'submitted', `${f.events.join(',')}\n${f.errors.join('\n')}`);
    assert.equal(f.events.filter(method => method === 'reserve_launch').length, 1);
    assert.equal(f.events.filter(method => method === 'report_launch').length, 1);
    assert.equal(f.events.filter(method => method === 'command_postrun').length, 1);
    assert.equal(f.events.filter(method => method === 'command_finish').length, 0);
    assert.ok(f.events.indexOf('quiesce') < f.events.indexOf('command_postrun'));
    assert.equal(existsSync(join(f.root, 'work', rootWorkflow, run, 'live.txt')), true);
    assert.equal(readFileSync(join(f.root, 'work', rootWorkflow, run, 'started.txt'), 'utf8'), 'x');
    assert.equal(ambient.OWENLOOP_TOKEN, 'operator-secret');
  } finally {
    await new Promise<void>((resolve, reject) => f.server.close(error => error ? reject(error) : resolve()));
    f.stage.cleanup();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('wrong current child frame and changed input binding refuse before shell start', async () => {
  for (const options of [{ claimFrame: 'routing/sibling' }, { inputMismatch: true }]) {
    const f = await fixture(options);
    try {
      const prepare = () => prepareRoutedCommandRunner({ handoff: f.handoff,
	originalEnv: { PATH: process.env.PATH, OWENLOOP_ALLOWED_WORKDIR_ROOTS: join(f.root, 'work') },
	out: () => {}, err: () => {} });
      if (options.claimFrame) await assert.rejects(prepare(), /routed command role refused/);
      else assert.equal(await (await prepare()).run(), 'unresolved-instructions');
      assert.equal(f.events.filter(method => method === 'reserve_launch').length, 0);
      assert.equal(f.events.filter(method => method === 'command_postrun').length, 0);
      assert.equal(existsSync(join(f.root, 'work', rootWorkflow, run, 'live.txt')), false);
      assert.equal(existsSync(join(f.root, 'work', rootWorkflow, run, 'started.txt')), false);
      assert.equal(f.events.filter(method => method === 'command_finish').length,
	options.claimFrame ? 0 : 1);
    } finally {
      await new Promise<void>((resolve, reject) => f.server.close(error => error ? reject(error) : resolve()));
      f.stage.cleanup(); rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('still-held parent postrun makes one scoped finish after one physical command', async () => {
  const f = await fixture({ postrunClaim: 'held' });
  try {
    const prepared = await prepareRoutedCommandRunner({ handoff: f.handoff,
      originalEnv: { PATH: process.env.PATH, OWENLOOP_ALLOWED_WORKDIR_ROOTS: join(f.root, 'work') },
      out: () => {}, err: () => {} });
    assert.equal(await prepared.run(), 'submitted');
    assert.equal(f.events.filter(method => method === 'command_postrun').length, 1);
    assert.equal(f.events.filter(method => method === 'command_finish').length, 1);
    assert.ok(f.events.indexOf('command_postrun') < f.events.indexOf('command_finish'));
  } finally {
    await new Promise<void>((resolve, reject) => f.server.close(error => error ? reject(error) : resolve()));
    f.stage.cleanup(); rmSync(f.root, { recursive: true, force: true });
  }
});

test('operator stop settles the real command group before one scoped finish and no postrun', async () => {
  const f = await fixture({ command: 'printf x >> started.txt; exec sleep 30' });
  try {
    const prepared = await prepareRoutedCommandRunner({ handoff: f.handoff,
      originalEnv: { PATH: process.env.PATH, OWENLOOP_ALLOWED_WORKDIR_ROOTS: join(f.root, 'work') },
      out: () => {}, err: line => f.errors.push(line) });
    const running = prepared.run();
    const marker = join(f.root, 'work', rootWorkflow, run, 'started.txt');
    for (let i = 0; i < 500 && !existsSync(marker); i++)
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(readFileSync(marker, 'utf8'), 'x', f.errors.join('\n'));
    prepared.loop.stop();
    assert.equal(await running, 'killed', f.errors.join('\n'));
    assert.equal(f.events.filter(method => method === 'reserve_launch').length, 1);
    assert.equal(f.events.filter(method => method === 'report_launch').length, 1);
    assert.equal(f.events.filter(method => method === 'quiesce').length, 1);
    assert.equal(f.events.filter(method => method === 'command_postrun').length, 0);
    assert.equal(f.events.filter(method => method === 'command_finish').length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => f.server.close(error => error ? reject(error) : resolve()));
    f.stage.cleanup(); rmSync(f.root, { recursive: true, force: true });
  }
});
