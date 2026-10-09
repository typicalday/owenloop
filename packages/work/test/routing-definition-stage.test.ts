import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRoutedDefinitionMaintenance, stageRoutedDefinition } from '../src/shift/routing-definition-stage.ts';
import { bindTrustedRoutedInputV2 } from '../src/hosted/trusted-input-admission.ts';
import { createConsumedVerifier } from '../src/consumed-verifier.ts';
import { openRoutingRoleStage } from '../src/roles/routing-role-stage.ts';
import type { RoutingHandoffV1 } from '../src/shift/runtime.ts';
import { HubError, type GetOrderResponse, type WorkOrder } from '../src/hub/types.ts';
import { packBundle } from '../../../src/bundle/index.ts';
import { canonicalJsonBytes } from '../../../src/install.ts';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import type { RoutedClaimV2, RoutedReferenceV2 } from '../src/hosted/trusted-routed-reference-v2.ts';
import type { OrderPacket, ReferenceRouting } from '../src/hub/types.ts';
import { DSSE_SSH_NAMESPACE, dsseSignPublication } from '../../../src/crypto/dsse.ts';
import { createSshSigner } from '../../../src/crypto/ssh.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { writeBundleSource } from '../../../test/helpers/store-fixture.ts';

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const workflow = 'name: recovered\ninputs: []\nsteps:\n  - name: command\n    consumes: []\n    produces: [out]\n    terminal: true\n    command: echo recovered\n';

async function fixture(workflowSource = workflow, bundleSource?: string) {
  const home = temp('routing-stage-home-');
  const stateDir = temp('routing-stage-state-');
  const workRoot = temp('routing-stage-work-');
  const packed = packBundle(bundleSource ?? writeBundleSource({ name: 'recovered', workflow: workflowSource }));
  const keyPath = join(home, 'publisher');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'ignore' });
  const publicKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  const config = join(home, '.owenloop');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'allowed_signers'), `publisher ${publicKey.openSshPublicKey}\n`, { mode: 0o600 });
  writeFileSync(join(config, 'credentials.json'), 'private-credential-marker', { mode: 0o600 });
  const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: keyPath });
  const signed = await dsseSignPublication(Buffer.from(canonicalJsonBytes({
    digest: packed.digest, name: packed.manifest.package.name,
    version: packed.manifest.package.version, publisherKeyId: publicKey.keyid, timestamp: Date.now(),
  })), signer);
  const publication = canonicalJsonBytes(signed.envelope);
  const order: WorkOrder = { workflow: 'wf', run: 'run', step: 'command', worker: 'command',
    defDigest: packed.digest, consumes: {}, expected_outputs: [], feedback: [], advisory: {}, submit_hint: '' };
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    if (path === `/api/bundles/${packed.digest}`) return new Response(packed.bytes, { status: 200 });
    if (path === `/api/publications/${packed.digest}`) return new Response(publication, { status: 200,
      headers: { 'x-owenloop-publication-state': 'signed' } });
    if (path === `/api/origins/${packed.digest}`) return new Response(null, { status: 404 });
    throw new Error('unexpected request');
  };
  const args = { order, rootWorkflow: 'wf', origin: 'https://hub.example', token: 'secret-marker', stateDir, workRoot,
    sourceEnv: { HOME: home }, beforeRequest: () => {}, onRateLimit: (_error: HubError) => {},
    stillAuthorized: () => true, fetchImpl };
  return { args, config, home, stateDir, seen, packed, keyPath, publicKey };
}

function mixedNamespaceSource(): string {
  const root = temp('routing-mixed-namespace-');
  writeFileSync(join(root, 'bundle.yaml'), [
    'formatVersion: 2', 'package:', '  name: routing', '  version: 1.0.0',
    'workflows:', '  "routing/parent": "parent.yaml"', '  "other/child": "child.yaml"',
    'default: "routing/parent"', 'platforms: []', 'integrity:',
    '  algorithm: sha256', '  files: {}', 'capabilities: {}', 'lock: {}', '',
  ].join('\n'));
  writeFileSync(join(root, 'parent.yaml'), 'name: routing/parent\ninputs: []\nsteps:\n' +
    '  - name: command\n    consumes: []\n    produces: [out]\n' +
    '    terminal: true\n    command: echo parent\n');
  writeFileSync(join(root, 'child.yaml'), 'name: other/child\ninputs: []\nsteps:\n' +
    '  - name: child\n    consumes: []\n    produces: [other]\n' +
    '    terminal: true\n    command: echo child\n');
  return root;
}

test('mixed authored namespace origin rule applies at staging and fresh verifyOrder', async () => {
  const f = await fixture(workflow, mixedNamespaceSource());
  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ originRules: { routing: 'any', other: 'git' } }));
  await assert.rejects(stageRoutedDefinition(f.args), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);

  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ originRules: { routing: 'any', other: 'any' } }));
  const stage = await stageRoutedDefinition(f.args);
  const response: GetOrderResponse = { text: '', workflow: 'wf', run: 'run', lease: { claimed: true },
    order: { workflow: 'wf', run: 'run', step: 'command', key: '', defDigest: f.packed.digest,
      worker: 'command', inputs: [], outputs: ['out'], consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] } };
  await stage.verifyOrder(response);
  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ originRules: { routing: 'any', other: 'git' } }));
  await assert.rejects(stage.verifyOrder(response), /routed definition origin changed/);
  stage.cleanup();
});

test('routed staging keeps signed exact bytes and public trust private without mutating ordinary store', async () => {
  const f = await fixture();
  const stage = await stageRoutedDefinition(f.args);
  assert.equal(stage.digest, f.packed.digest);
  assert.deepEqual(f.seen, [
    `/api/bundles/${f.packed.digest}`, `/api/publications/${f.packed.digest}`, `/api/origins/${f.packed.digest}`,
  ]);
  assert.equal(existsSync(join(stage.path, 'public', 'allowed_signers')), true);
  assert.equal(existsSync(join(stage.path, 'public', 'credentials.json')), false);
  assert.equal(existsSync(join(f.home, '.owenloop', 'store')), false);
  const descriptor = JSON.parse(readFileSync(join(stage.path, 'stage.json'), 'utf8'));
  assert.equal(descriptor.digest, f.packed.digest);
  assert.equal(JSON.stringify(descriptor).includes('secret-marker'), false);
  stage.cleanup();
  assert.equal(existsSync(stage.path), false);
});

test('parent full-order gate rechecks current publication trust and actual workdir', async () => {
  const f = await fixture();
  let prestartAuthorized = true;
  const stage = await stageRoutedDefinition({ ...f.args, stillAuthorized: () => prestartAuthorized });
  const response: GetOrderResponse = { text: '', workflow: 'wf', run: 'run', lease: { claimed: true },
    order: { workflow: 'wf', run: 'run', step: 'command', key: '', defDigest: f.packed.digest,
      worker: 'command', inputs: [], outputs: ['out'], consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] } };
  await stage.verifyOrder(response);
  prestartAuthorized = false;
  await stage.verifyOrder(response); // Broker, not pre-start preference, gates the live original session.
  assert.equal(stage.canReplay(response.order!, 'out'), true);
  await assert.rejects(stage.verifyOrder({ ...response, order: { ...response.order!, workdir: stage.path } }),
    /routed workdir overlaps definition trust/);
  writeFileSync(join(f.config, 'allowed_signers'), '', { mode: 0o600 });
  await assert.rejects(stage.verifyOrder(response), /routed definition trust changed|routed command definition refused/);
  stage.cleanup();
});

test('parent full-order gate refuses input-derived workdir without an authenticated input witness', async () => {
  const f = await fixture('name: recovered\ninputs:\n  - name: target\nsteps:\n  - name: command\n' +
    '    consumes: []\n    produces: [out]\n    terminal: true\n' +
    '    workdirFrom: target.path\n    command: echo recovered\n');
  const stage = await stageRoutedDefinition(f.args);
  const response: GetOrderResponse = { text: '', workflow: 'wf', run: 'run', lease: { claimed: true },
    order: { workflow: 'wf', run: 'run', step: 'command', key: '', defDigest: f.packed.digest,
      worker: 'command', workdir: f.args.workRoot, inputs: [], outputs: ['out'], consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] } };
  await assert.rejects(stage.verifyOrder(response), /routed workdir witness unavailable/);
  stage.cleanup();
});

test('parent signed stage admits an exact Service input-derived cwd witness and refuses changed values', async () => {
  const f = await fixture('name: recovered\ninputs:\n  - name: target\nsteps:\n  - name: command\n' +
    '    executor: command\n    consumes: []\n    produces: [out]\n    terminal: true\n' +
    '    workdirFrom: target.path\n    command: echo recovered\n');
  const signedBinding = { runId: 'wf', frameId: 'wf_child_instance',
    def: { bundleDigest: `sha256:${f.packed.digest}`, workflowName: 'recovered' } };
  const routing = { claim: { claimId: 'run', orderId: 'run', decisionId: 'decision',
    sessionId: 'rs_12345678-1234-1234-1234-123456789abc', shiftId: 'shf_service',
    attemptId: 'attempt', binding: signedBinding },
  decision: { decisionId: 'decision', binding: signedBinding },
  preference: { rosterRevision: 'a'.repeat(64), expiresAt: Date.now() + 60_000 },
  } as unknown as ReferenceRouting;
  const stagedOrder = { ...f.args.order, workflow: 'wf_child_instance', routing };
  await assert.rejects(stageRoutedDefinition({ ...f.args, order: stagedOrder,
    rootWorkflow: 'other_root' }), /routed definition staging refused/);
  const wrongDefinition = structuredClone(routing);
  wrongDefinition.claim.binding.def.workflowName = 'other/child';
  wrongDefinition.decision.binding.def.workflowName = 'other/child';
  await assert.rejects(stageRoutedDefinition({ ...f.args,
    order: { ...stagedOrder, routing: wrongDefinition } }), /routed definition staging refused/);
  const stage = await stageRoutedDefinition({ ...f.args, order: stagedOrder });
  try {
    const packet: OrderPacket = { workflow: 'wf_child_instance', run: 'run', step: 'command', key: '',
      defDigest: f.packed.digest, worker: 'command', workdir: f.args.workRoot,
      inputs: [], outputs: ['out'], consumes: {}, consumedFingerprint: {},
      owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }], routing };
    const response: GetOrderResponse = { text: '', workflow: 'wf_child_instance', run: 'run',
      lease: { claimed: true }, order: packet };
    assert.equal(await stage.commandFor!(packet), 'echo recovered');
    await assert.rejects(stage.commandFor!({ ...packet, workflow: 'wf_sibling_instance' }),
      /routed command definition refused/);
    await assert.rejects(stage.verifyOrder({ ...response, workflow: 'wf' }), /routed order changed/);
    await assert.rejects(stage.verifyOrder({ ...response,
      order: { ...packet, workflow: 'wf_sibling_instance' } }), /routed order changed/);
    const binding = { rootWorkflow: 'wf', frameWorkflow: 'wf_child_instance', run: 'run',
      claimId: 'run', decisionId: 'decision', sessionId: routing.claim.sessionId,
      shiftId: routing.claim.shiftId, orderDigest: 'b'.repeat(64),
      authorityRevision: 'c'.repeat(64), rosterRevision: routing.preference.rosterRevision,
      routingDigest: valueDigestHex(routing), preferenceExpiresAt: routing.preference.expiresAt };
    const pair: { reference: RoutedReferenceV2; claim: RoutedClaimV2 } = {
      reference: { protocol: 'trusted-routed-reference-read-v2', state: 'available',
	workflow: 'wf', run: 'run', order: { ...packet,
	  owes: [{ path: 'out', version: 1 }] } as unknown as OrderPacket,
	inputs: [],
	workdirInput: { stem: 'target', version: 1,
	  value: { path: f.args.workRoot } }, lease: { claimed: true }, binding },
      claim: { protocol: 'routing-claim-read-v2', state: 'available',
	workflow: 'wf', run: 'run', routing, binding },
    };
    await assert.rejects(stage.verifyOrder(response), /routed order fields changed|routed workdir witness unavailable/);
    const opened = openRoutingRoleStage({ definitionStage: { path: stage.path, digest: stage.digest },
      reservation: { workflow: 'wf', run: 'run' } } as RoutingHandoffV1);
    assert.equal(opened.frameWorkflow, 'wf_child_instance');
    assert.equal(opened.definitionName, 'recovered');
    const direct = await bindTrustedRoutedInputV2({ phase: 'prestart', pair, privateOrder: packet,
      instructions: opened.instructions, consumedVerifier: createConsumedVerifier({
	env: opened.publicEnv, now: Date.now, artifactPolicy: 'enforce' }),
      expected: { workflow: 'wf', run: 'run' } });
    assert.equal(direct.ok, true, JSON.stringify(direct));
    await stage.verifyRoutedInput!(response, pair, 'prestart');
    const changed = structuredClone(pair);
    if (changed.reference.state !== 'available') assert.fail('missing witness');
    changed.reference.workdirInput!.value = { path: f.stateDir };
    await assert.rejects(stage.verifyRoutedInput!(response, changed, 'prestart'),
      /routed input witness refused/);
  } finally { stage.cleanup(); }
});

test('routed role opens only the staged public definition store', async () => {
  const f = await fixture();
  const stage = await stageRoutedDefinition(f.args);
  const handoff = { definitionStage: { path: stage.path, digest: stage.digest },
    reservation: { workflow: 'wf', run: 'run' } } as RoutingHandoffV1;
  const opened = openRoutingRoleStage(handoff);
  assert.throws(() => openRoutingRoleStage({ ...handoff,
    reservation: { ...handoff.reservation, workflow: 'other_root' } }),
  /routing definition stage refused/);
  assert.equal(opened.publicEnv.OWENLOOP_CONFIG_DIR, join(stage.path, 'public'));
  assert.equal(opened.publicEnv.HOME, join(stage.path, 'home'));
  assert.equal(JSON.stringify(opened.publicEnv).includes('secret-marker'), false);
  const command = await opened.instructions.resolveCommand({ workflow: 'wf', run: 'run', step: 'command',
    key: '', defDigest: f.packed.digest, worker: 'command', inputs: [], outputs: ['out'], consumes: {},
    owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] });
  assert.equal(command.ok, true);
  stage.cleanup();
  assert.throws(() => openRoutingRoleStage(handoff), /routing definition stage refused/);
});

test('routed staging applies matched origin rules but permits namespaces without a rule', async () => {
  const f = await fixture();
  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ originRules: { '*': 'git' } }));
  await assert.rejects(stageRoutedDefinition(f.args), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});

test('routed staging propagates sanitized 429 and refuses further bundle requests', async () => {
  const f = await fixture();
  const observed: HubError[] = [];
  const fetchImpl: typeof fetch = async input => {
    f.seen.push(new URL(String(input)).pathname);
    return new Response('secret-marker', { status: 429, headers: { 'retry-after': '7' } });
  };
  await assert.rejects(stageRoutedDefinition({ ...f.args, fetchImpl, onRateLimit: error => observed.push(error) }),
    (error: unknown) => error instanceof HubError && error.status === 429 && error.retryAfterMs === 7_000
      && !error.message.includes('secret-marker'));
  assert.equal(f.seen.length, 1);
  assert.equal(observed.length, 1);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});

test('routed staging rejects a lost local claim before recovery fetch', async () => {
  const f = await fixture();
  await assert.rejects(stageRoutedDefinition({ ...f.args, stillAuthorized: () => false }),
    /routed definition staging refused/);
  assert.equal(f.seen.length, 0);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});

test('routed staging refuses a state root within the worker root before any fetch', async () => {
  const f = await fixture();
  await assert.rejects(stageRoutedDefinition({ ...f.args, workRoot: f.stateDir }),
    /routed definition staging refused/);
  assert.equal(f.seen.length, 0);
  assert.equal(readdirSync(f.stateDir).length, 0);
});

test('routed staging rejects signer trust revoked after private install', async () => {
  const f = await fixture();
  let checks = 0;
  await assert.rejects(stageRoutedDefinition({ ...f.args, stillAuthorized: () => {
    checks++;
    if (checks === 4) writeFileSync(join(f.config, 'allowed_signers'), '', { mode: 0o600 });
    return true;
  } }), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
  assert.equal(existsSync(join(f.home, '.owenloop', 'store')), false);
});

test('routed staging applies a newly configured origin rule before returning the snapshot', async () => {
  const f = await fixture();
  let checks = 0;
  await assert.rejects(stageRoutedDefinition({ ...f.args, stillAuthorized: () => {
    checks++;
    if (checks === 4) writeFileSync(join(f.config, 'settings.json'),
      JSON.stringify({ originRules: { '*': 'git' } }));
    return true;
  } }), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});

test('bounded stage maintenance removes an old crash orphan but preserves a fresh snapshot', async () => {
  const f = await fixture();
  const old = await stageRoutedDefinition(f.args);
  const fresh = await stageRoutedDefinition(f.args);
  const age = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(old.path, age, age);
  const maintenance = createRoutedDefinitionMaintenance({ stateDir: f.stateDir, workRoot: f.args.workRoot });
  maintenance.sweep();
  maintenance.close();
  assert.equal(existsSync(old.path), false);
  assert.equal(existsSync(fresh.path), true);
  fresh.cleanup();
});

test('activated stage survives terminal cleanup, 24-hour age and maintenance restart until explicit owner cleanup', async () => {
  const f = await fixture();
  const stage = await stageRoutedDefinition(f.args);
  const owner = { workflow: 'wf', run: 'run', pid: 92345, spawnedAt: 1_000 };
  stage.activate(owner);
  stage.markGateMayOpen(owner);
  assert.deepEqual(JSON.parse(readFileSync(join(stage.path, 'owner.json'), 'utf8')), owner);
  stage.cleanup();
  assert.equal(existsSync(stage.path), true);
  const age = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(stage.path, age, age);
  for (let restart = 0; restart < 2; restart++) {
    const maintenance = createRoutedDefinitionMaintenance({ stateDir: f.stateDir,
      workRoot: f.args.workRoot });
    maintenance.sweep(); maintenance.close();
    assert.equal(existsSync(stage.path), true);
  }
  stage.cleanupAfterExit({ ...owner, spawnedAt: 999 });
  assert.equal(existsSync(stage.path), true);
  stage.cleanupAfterExit(owner);
  assert.equal(existsSync(stage.path), false);
});

test('restart reaps an activated child that died before its start gate opened', async () => {
  const f = await fixture();
  const stage = await stageRoutedDefinition(f.args);
  const owner = { workflow: 'wf', run: 'run', pid: 92346, spawnedAt: 1_000 };
  stage.activate(owner);
  const maintenance = createRoutedDefinitionMaintenance({ stateDir: f.stateDir,
    workRoot: f.args.workRoot, isAlive: () => false });
  maintenance.sweep(); maintenance.close();
  assert.equal(existsSync(stage.path), false);
});

test('routed staging fetches the signed locked child and refuses child-only unsigned evidence', async () => {
  const f = await fixture();
  const child = packBundle(writeBundleSource({ name: 'child', workflow: `name: child
inputs:
  - name: data
    seedOwed: true
steps:
  - name: child-runner
    consumes: [data]
    produces: [delivered]
    terminal: true
    command: echo child
outputs: [delivered]
` }));
  const target = 'child/child@1.0.0';
  const childKeyPath = join(f.home, 'child-publisher');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', childKeyPath], { stdio: 'ignore' });
  const childKey = publicKeyDescriptor(readFileSync(`${childKeyPath}.pub`, 'utf8'));
  const parentSignerLine = `publisher ${f.publicKey.openSshPublicKey}\n`;
  writeFileSync(join(f.config, 'allowed_signers'),
    parentSignerLine + `child-publisher ${childKey.openSshPublicKey}\n`, { mode: 0o600 });
  const parent = packBundle(writeBundleSource({ name: 'parent', lock: { [target]: child.digest }, workflow: `name: parent
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: ordinary
    consumes: [seed]
    produces: [ordinary-out]
    command: echo parent
  - name: invoke-child
    calls: ${target}
    inputs:
      data: seed
    produces: [delivered]
  - name: finish
    consumes: [ordinary-out, delivered]
    produces: [out]
    terminal: true
    body: ""
outputs: [out]
` }));
  const publication = async (packed: typeof child, signKeyPath: string, publisherKeyId: string) => {
    const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath });
    const signed = await dsseSignPublication(Buffer.from(canonicalJsonBytes({
      digest: packed.digest, name: packed.manifest.package.name,
      version: packed.manifest.package.version, publisherKeyId, timestamp: Date.now(),
    })), signer);
    return canonicalJsonBytes(signed.envelope);
  };
  const evidence = new Map([[child.digest, await publication(child, childKeyPath, childKey.keyid)],
    [parent.digest, await publication(parent, f.keyPath, f.publicKey.keyid)]]);
  const bundles = new Map([[child.digest, child.bytes], [parent.digest, parent.bytes]]);
  let unsignedChild = false;
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    f.seen.push(path);
    const [, , resource, digest] = path.split('/');
    if (resource === 'bundles') return new Response(bundles.get(digest!) ?? null, { status: bundles.has(digest!) ? 200 : 404 });
    if (resource === 'publications') return unsignedChild && digest === child.digest
      ? new Response('unsigned', { status: 200, headers: { 'x-owenloop-publication-state': 'unsigned' } })
      : new Response(evidence.get(digest!) ?? null, { status: evidence.has(digest!) ? 200 : 404,
	headers: { 'x-owenloop-publication-state': 'signed' } });
    if (resource === 'origins') return new Response(null, { status: 404 });
    throw new Error('unexpected request');
  };
  const args = { ...f.args, order: { ...f.args.order, step: 'ordinary', defDigest: parent.digest }, fetchImpl };
  const stage = await stageRoutedDefinition(args);
  assert.ok(f.seen.includes(`/api/bundles/${child.digest}`));
  assert.ok(f.seen.includes(`/api/publications/${child.digest}`));
  stage.cleanup();
  let checks = 0;
  await assert.rejects(stageRoutedDefinition({ ...args, stillAuthorized: () => {
    checks++;
    if (checks === 7) {
      const root = join(f.stateDir, '.routing-definitions');
      const current = readdirSync(root).find(name => name.startsWith('.routing-def-'))!;
      writeFileSync(join(root, current, 'public', 'allowed_signers'), parentSignerLine);
    }
    return true;
  } }), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0,
    'child-only trust loss after download invalidates the complete calls closure');
  unsignedChild = true;
  f.seen.length = 0;
  await assert.rejects(stageRoutedDefinition(args), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});
