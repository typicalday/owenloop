import assert from 'node:assert/strict';
import { accessSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { encodeBase64, PAYLOAD_TYPE_SUBMISSION } from '../../../src/crypto/dsse.ts';
import { keyidFromBlob, publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { createBundleIngestor } from '../../../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { createConsumedVerifier } from '../src/consumed-verifier.ts';
import { createExecLoop } from '../src/exec/loop.ts';
import { createDefaultRunner } from '../src/exec/runner.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import { createHubClient } from '../src/hub/client.ts';
import type { GetOrderResponse, OrderPacket } from '../src/hub/types.ts';
import type { SubmissionKeyManager } from '../src/submit-proof.ts';
import type { SshProcessAdapter } from '../../../src/crypto/ssh.ts';

const CWD = tempDir('owenloop-exec-consumed-e2e-cwd-');
const EXEC = { kind: 'exec' as const, id: 'consumed-e2e:worker' };
const rootBlob = Buffer.from('synthetic-exec-consumed-root');
const ROOT_PUBLIC_KEY = `ssh-ed25519 ${rootBlob.toString('base64')} consumed-root`;
const ROOT_KEY_ID = keyidFromBlob(rootBlob);
const ROOT_KEY = publicKeyDescriptor(ROOT_PUBLIC_KEY);
const SIGNATURE_ARMOR = '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';
const COMMAND_MARKER = join(CWD, 'consumed-command-ran');
const LOCAL_COMMAND = `touch ${COMMAND_MARKER}; printf "consumed-command-ran\\n"`;
const WORKFLOW = `name: exec-consumed-fixture
inputs:
  - name: input
    seedOwed: true
steps:
  - name: builder
    consumes: [input]
    produces: [out]
    terminal: true
    executor: command
    command: '${LOCAL_COMMAND}'
    body: ""
`;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface HubReq {
  verb: string;
  body: Record<string, unknown> | undefined;
}

async function startHub(order: GetOrderResponse): Promise<{ origin: string; reqs: HubReq[]; server: Server }> {
  const reqs: HubReq[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const verb = (req.url ?? '').replace(/^\/api\//, '');
      reqs.push({ verb, body: raw === '' ? undefined : JSON.parse(raw) as Record<string, unknown> });
      res.setHeader('content-type', 'application/json');
      if (verb === 'get_order') res.end(JSON.stringify(order));
      else if (verb === 'submit') res.end(JSON.stringify({ text: '', outcome: 'green' }));
      else res.end(JSON.stringify({ text: '' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, reqs, server };
}

function submissionProof(value: unknown): string {
  const record = {
    run: 'run-consumed-e2e',
    workflow: 'wf-consumed-e2e',
    defDigest: 'resolved-locally',
    step: 'builder',
    key: 'builder-key',
    produced: [{ artifact: 'input', version: 4, valueDigest: valueDigestHex(value) }],
    consumedFingerprint: {},
    producerKeyId: ROOT_KEY_ID,
    timestamp: 10,
  };
  return JSON.stringify({
    payloadType: PAYLOAD_TYPE_SUBMISSION,
    payload: encodeBase64(Buffer.from(JSON.stringify(record), 'utf8')),
    signatures: [{ sig: encodeBase64(Buffer.from('synthetic-signature', 'utf8')) }],
  });
}

function order(defDigest: string, deliveredValue: unknown, consumesProof?: string, run = 'run-consumed-e2e'): GetOrderResponse {
  const packet: OrderPacket = {
    run,
    workflow: 'wf-consumed-e2e',
    step: 'builder',
    key: 'builder-key',
    inputs: ['input'],
    outputs: [],
    worker: 'command',
    defDigest,
    consumes: { input: deliveredValue },
    consumedFingerprint: { input: 4 },
    owes: [{ path: 'out', version: 0, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    ...(consumesProof === undefined ? {} : { consumesProof }),
  };
  return { text: '', workflow: packet.workflow, run, order: packet, lease: { claimed: true } };
}

function signingKeys(origin: string): SubmissionKeyManager {
  return {
    resolveRef: () => ({ origin, kind: 'machine', id: 'local' }),
    inspect: async () => ({ exists: true, source: 'generated', backend: 'file', publicKey: ROOT_KEY }),
    withSigningKey: async (_ref, callback) => callback('/fake/private-key'),
  };
}

function fakeSshProcess(): SshProcessAdapter {
  return {
    probe: () => ({ status: 255, stderr: Buffer.from('No principal matched\n') }),
    async run(_cmd, args) {
      const stdout = args[0] === '-y' && args[1] === '-f' ? ROOT_PUBLIC_KEY : SIGNATURE_ARMOR;
      return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
    },
  };
}

function makeLoop(
  origin: string,
  resolver: ReturnType<typeof createStoreInstructionResolver>,
  run = 'run-consumed-e2e',
  signSubmissions = false,
): ReturnType<typeof createExecLoop> {
  return createExecLoop({
    hub: createHubClient({ origin, getToken: async () => 'consumed-e2e-token' }),
    runner: createDefaultRunner(),
    workflow: 'wf-consumed-e2e',
    run,
    ...(signSubmissions ? { origin, principalKeys: signingKeys(origin), sshProcess: fakeSshProcess() } : {}),
    holder: EXEC,
    instructions: resolver,
    cwd: CWD,
    sleep: realSleep,
    now: () => Date.now(),
    out: () => {},
    err: () => {},
    heartbeatIntervalMs: 25,
  });
}

function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function trustEnv(): Record<string, string | undefined> {
  const config = mkdtempSync(join(tmpdir(), 'owenloop-exec-consumed-trust-'));
  mkdirSync(join(config, 'owenloop'), { recursive: true });
  writeFileSync(join(config, 'owenloop', 'org-root.pub'), ROOT_PUBLIC_KEY);
  return { XDG_CONFIG_HOME: config };
}

function signerForPrincipal({ allowedSignersText }: { allowedSignersText: string }) {
  const publicKey = allowedSignersText.trim().split(/\s+/).slice(1).join(' ');
  const selected = publicKeyDescriptor(publicKey);
  return {
    verify: async () => ({ keyid: selected.keyid, principal: 'synthetic-signer', format: 'sshsig' as const }),
  };
}

async function fixture(): Promise<{ projectRoot: string; defDigest: string; env: Record<string, string | undefined> }> {
  const sourceDir = writeBundleSource({ name: 'exec-consumed-fixture', workflow: WORKFLOW });
  const projectRoot = join(tempDir('owenloop-exec-consumed-project-'), 'workflows');
  const installed = await installBundleFixture({ sourceDir, root: projectRoot });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition !== undefined);
  return {
    projectRoot,
    defDigest: defInstructionDigest(definition),
    env: trustEnv(),
  };
}

function resolverFor(fixtureData: Awaited<ReturnType<typeof fixture>>, artifactPolicy: 'off' | 'warn' | 'enforce' = 'off') {
  const consumedVerifier = createConsumedVerifier({
    env: fixtureData.env,
    artifactPolicy,
    now: () => 100,
    signerForPrincipal,
  });
  return createStoreInstructionResolver({
    projectRoot: fixtureData.projectRoot,
    globalRoot: tempDir('owenloop-exec-consumed-global-'),
    verifier: createBundleIngestor(),
    definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
    consumedVerifier,
    env: fixtureData.env,
  });
}

test('command e2e: no proof refuses before spawn', async () => {
  const fixtureData = await fixture();
  const marker = COMMAND_MARKER;
  rmSync(marker, { force: true });
  const first = await startHub(order(fixtureData.defDigest, 'dynamic-value', undefined, 'run-no-proof'));
  try {
    const loop = makeLoop(first.origin, resolverFor(fixtureData), 'run-no-proof');
    assert.equal(await loop.run(), 'unresolved-instructions');
    assert.equal(pathExists(marker), false);
    assert.equal(first.reqs.filter((request) => request.verb === 'submit').length, 0);
    assert.equal(first.reqs.filter((request) => request.verb === 'release').length, 1);
  } finally {
    first.server.close();
  }
});

test('command e2e: proof over a different value refuses before spawn', async () => {
  const fixtureData = await fixture();
  const marker = COMMAND_MARKER;
  rmSync(marker, { force: true });
  const signedValue = 'signed-value';
  const deliveredValue = 'tampered-value';
  const second = await startHub(order(
    fixtureData.defDigest,
    deliveredValue,
    JSON.stringify({ input: submissionProof(signedValue) }),
    'run-wrong-value',
  ));
  try {
    const loop = makeLoop(second.origin, resolverFor(fixtureData), 'run-wrong-value');
    assert.equal(await loop.run(), 'unresolved-instructions');
    assert.equal(pathExists(marker), false);
    assert.equal(second.reqs.filter((request) => request.verb === 'submit').length, 0);
    assert.equal(second.reqs.filter((request) => request.verb === 'release').length, 1);
  } finally {
    second.server.close();
  }
});

test('command e2e: malformed proof refuses even when artifact policy is off', async () => {
  const fixtureData = await fixture();
  const third = await startHub(order(
    fixtureData.defDigest,
    'dynamic-value',
    '{malformed-json',
    'run-invalid-off',
  ));
  try {
    const loop = makeLoop(third.origin, resolverFor(fixtureData, 'off'), 'run-invalid-off');
    assert.equal(await loop.run(), 'unresolved-instructions');
    assert.equal(third.reqs.filter((request) => request.verb === 'submit').length, 0);
    assert.equal(third.reqs.filter((request) => request.verb === 'release').length, 1);
  } finally {
    third.server.close();
  }
});

test('command e2e: unsigned feedback does not block a command with signed consumed artifacts', async () => {
  const fixtureData = await fixture();
  const marker = COMMAND_MARKER;
  rmSync(marker, { force: true });
  const packet = order(
    fixtureData.defDigest,
    'dynamic-value',
    JSON.stringify({ input: submissionProof('dynamic-value') }),
    'run-feedback-without-proof',
  );
  assert.ok(packet.order !== null);
  packet.order.owes[0]!.reasons = [{
    at: 20,
    action: 'reject',
    kind: 'structural',
    by: 'engine',
    text: 'auto-invalidated: input changed',
    fromVersion: 1,
  }];

  const hub = await startHub(packet);
  try {
    const loop = makeLoop(hub.origin, resolverFor(fixtureData), 'run-feedback-without-proof');
    assert.equal(await loop.run(), 'submitted');
    assert.equal(pathExists(marker), true);
    assert.equal(hub.reqs.filter((request) => request.verb === 'submit').length, 1);
    assert.equal(hub.reqs.filter((request) => request.verb === 'release').length, 0);
  } finally {
    hub.server.close();
    rmSync(marker, { force: true });
  }
});

test('command e2e: attacker feedback cannot select the version in a signed receipt proof', async () => {
  const fixtureData = await fixture();
  const marker = COMMAND_MARKER;
  rmSync(marker, { force: true });
  const packet = order(fixtureData.defDigest, undefined, undefined, 'run-feedback-version');
  assert.ok(packet.order !== null);
  packet.order.inputs = [];
  packet.order.consumes = {};
  packet.order.consumedFingerprint = {};
  packet.order.owes[0]!.version = 0;
  packet.order.owes[0]!.reasons = [{
    at: 20,
    action: 'reject',
    kind: 'structural',
    by: 'engine',
    text: 'attacker-controlled feedback',
    fromVersion: 99,
  }];

  const hub = await startHub(packet);
  try {
    const loop = makeLoop(hub.origin, resolverFor(fixtureData), 'run-feedback-version', true);
    assert.equal(await loop.run(), 'submitted');
    assert.equal(pathExists(marker), true, 'unsigned feedback that cannot reach the command does not block execution');
    const submit = hub.reqs.find((request) => request.verb === 'submit');
    assert.ok(submit?.body !== undefined);
    const proof = submit.body['proof'];
    assert.equal(typeof proof, 'string');
    const envelope = JSON.parse(proof as string) as { payload: string };
    const record = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as {
      produced: Array<{ artifact: string; version: number }>;
    };
    assert.equal(record.produced[0]!.artifact, 'out');
    assert.equal(record.produced[0]!.version, 1);
    assert.notEqual(record.produced[0]!.version, 100);
  } finally {
    hub.server.close();
    rmSync(marker, { force: true });
  }
});
