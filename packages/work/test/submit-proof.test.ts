import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dsseVerifySubmission } from '../../../src/crypto/index.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { resetSshKeygenProbe } from '../../../src/crypto/ssh.ts';
import type { SshProcessAdapter } from '../../../src/crypto/ssh.ts';
import {
  buildSubmitProof,
  resetSubmitProofWarningForTests,
  type SubmissionKeyManager,
} from '../src/submit-proof.ts';
import type { OrderPacket } from '../src/hub/types.ts';

const PUB_TEXT = readFileSync(new URL('../../../test/fixtures/crypto/fixture-key.pub', import.meta.url), 'utf8');
const PUBLIC_KEY = publicKeyDescriptor(PUB_TEXT);
const ORIGIN = 'https://hub.example.test';
const REF = { origin: ORIGIN, kind: 'machine' as const, id: 'local' };
const ARMOR = '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';

const ORDER: OrderPacket = {
  run: 'run-1',
  workflow: 'workflow-1',
  step: 'producer',
  key: '',
  defDigest: 'def-digest',
  inputs: ['input'],
  outputs: ['result'],
  consumes: { input: { value: 'seen' } },
  consumedFingerprint: { input: 0 },
  owes: [
    {
      path: 'result',
      version: 4,
      judgmentRejects: 0,
      schemaRejects: 1,
      reasons: [{ at: 10, action: 'schema-reject', kind: 'validation', by: 'engine', text: 'bad shape', fromVersion: 99 }],
    },
  ],
};

function keysFor(path = '/fake/private-key'): SubmissionKeyManager {
  return {
    resolveRef: () => REF,
    inspect: async () => ({ exists: true, source: 'generated', backend: 'file', publicKey: PUBLIC_KEY }),
    withSigningKey: async (_ref, callback) => callback(path),
  };
}

function fakeSshProcess(calls: Array<{ cmd: string; args: string[]; stdin?: Buffer }>): SshProcessAdapter {
  return {
    probe: () => ({ status: 255, stderr: Buffer.from('No principal matched\n') }),
    async run(cmd, args, opts) {
      calls.push({ cmd, args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
      if (args[0] === '-y' && args[1] === '-f') {
        return { status: 0, stdout: Buffer.from(PUB_TEXT), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
      }
      return { status: 0, stdout: Buffer.from(ARMOR), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
    },
  };
}

afterEach(() => {
  resetSubmitProofWarningForTests();
  resetSshKeygenProbe();
});

test('buildSubmitProof signs at the driver boundary over the original value when the hub supplies the target version', async () => {
  const calls: Array<{ cmd: string; args: string[]; stdin?: Buffer }> = [];
  const proof = await buildSubmitProof({
    origin: ORIGIN,
    order: ORDER,
    path: 'result',
    value: { z: 2, a: ['unicode-雪'] },
    version: 5,
    now: () => 1234,
    warn: () => {},
    principalKeys: keysFor(),
    sshProcess: fakeSshProcess(calls),
  });
  assert.ok(proof !== undefined);
  const envelope = JSON.parse(proof) as { payloadType: string; payload: string; signatures: Array<{ sig: string }> };
  assert.equal(envelope.payloadType, 'application/vnd.owenloop.submission.v1+json');
  assert.equal(envelope.signatures.length, 1);
  assert.equal(calls[0]?.cmd, 'ssh-keygen');
  assert.deepEqual(calls[1]?.args.slice(0, 3), ['-Y', 'sign', '-f']);
  assert.equal(calls[1]?.stdin?.length !== undefined, true);

  const verified = await dsseVerifySubmission(envelope, {
    async verify(_bytes, signature) {
      return signature.toString('utf8') === ARMOR
        ? { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const }
        : null;
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as {
    produced: Array<{ artifact: string; version: number; valueDigest: string }>;
    consumedFingerprint: Record<string, number>;
    producerKeyId: string;
    timestamp: number;
  };
  assert.deepEqual(record.consumedFingerprint, { input: 0 });
  assert.equal(record.produced[0]!.artifact, 'result');
  assert.equal(record.produced[0]!.version, 5);
  assert.equal(record.producerKeyId, PUBLIC_KEY.keyid);
  assert.equal(record.timestamp, 1234);
});

test('buildSubmitProof uses an explicit committed version when provided', async () => {
  const proof = await buildSubmitProof({
    origin: ORIGIN,
    order: ORDER,
    path: 'result',
    value: { ok: true },
    version: 9,
    now: () => 1,
    warn: () => {},
    principalKeys: keysFor(),
    sshProcess: fakeSshProcess([]),
  });
  assert.ok(proof !== undefined);
  const envelope = JSON.parse(proof) as { payload: string };
  const verified = await dsseVerifySubmission(envelope, {
    async verify() {
      return { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const };
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as { produced: Array<{ version: number }> };
  assert.equal(record.produced[0]!.version, 9);
});

test('buildSubmitProof signs a producer submit at the hub-issued owed target version', async () => {
  const warnings: string[] = [];
  const proof = await buildSubmitProof({
    origin: ORIGIN,
    order: ORDER,
    path: 'result',
    value: { ok: true },
    now: () => 1,
    warn: (line) => warnings.push(line),
    principalKeys: keysFor(),
    sshProcess: fakeSshProcess([]),
  });
  assert.ok(proof !== undefined);
  assert.deepEqual(warnings, []);
  const envelope = JSON.parse(proof) as { payload: string };
  const verified = await dsseVerifySubmission(envelope, {
    async verify() {
      return { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const };
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as { produced: Array<{ version: number }> };
  // ORDER.owes[0].version is the target the engine issued for this claim, not
  // the currently-committed version — the producer signs it verbatim.
  assert.equal(record.produced[0]!.version, 4);
});

test('buildSubmitProof picks the owed target for the submitted path, not the first owed entry', async () => {
  const twoOutputs: OrderPacket = {
    ...ORDER,
    outputs: ['other', 'result'],
    owes: [
      { path: 'other', version: 7, judgmentRejects: 0, schemaRejects: 0, reasons: [] },
      { path: 'result', version: 4, judgmentRejects: 0, schemaRejects: 0, reasons: [] },
    ],
  };
  const proof = await buildSubmitProof({
    origin: ORIGIN,
    order: twoOutputs,
    path: 'result',
    value: { ok: true },
    now: () => 1,
    warn: () => {},
    principalKeys: keysFor(),
    sshProcess: fakeSshProcess([]),
  });
  assert.ok(proof !== undefined);
  const envelope = JSON.parse(proof) as { payload: string };
  const verified = await dsseVerifySubmission(envelope, {
    async verify() {
      return { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const };
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as { produced: Array<{ version: number }> };
  assert.equal(record.produced[0]!.version, 4);
});

test('buildSubmitProof falls back unsigned when the hub issues no owed target version', async () => {
  const warnings: string[] = [];
  let signingCalls = 0;
  const noTarget: OrderPacket = {
    ...ORDER,
    owes: ORDER.owes.map(({ version: _version, ...rest }) => rest),
  };
  const proof = await buildSubmitProof({
    origin: ORIGIN,
    order: noTarget,
    path: 'result',
    value: { ok: true },
    now: () => 1,
    warn: (line) => warnings.push(line),
    principalKeys: {
      ...keysFor(),
      withSigningKey: async () => {
	signingCalls += 1;
	throw new Error('withSigningKey must not run');
      },
    },
    sshProcess: fakeSshProcess([]),
  });
  assert.equal(proof, undefined);
  assert.equal(signingCalls, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /omitted authoritative version metadata/);
});

test('buildSubmitProof refuses a proof when consumed inputs have no fingerprint', async () => {
  const warnings: string[] = [];
  const omittedFingerprint = { ...ORDER, consumedFingerprint: undefined };
  let signingCalls = 0;
  const proof = await buildSubmitProof({
    origin: ORIGIN,
    order: omittedFingerprint,
    path: 'result',
    value: { ok: true },
    version: 5,
    now: () => 1,
    warn: (line) => warnings.push(line),
    principalKeys: {
      ...keysFor(),
      withSigningKey: async () => {
        signingCalls += 1;
        throw new Error('withSigningKey must not run');
      },
    },
    sshProcess: fakeSshProcess([]),
  });
  assert.equal(proof, undefined);
  assert.equal(signingCalls, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /omitted its consumed fingerprint/);
});

test('buildSubmitProof signs an explicitly empty fingerprint only for an order with no consumed inputs', async () => {
  const emptyOrder = { ...ORDER, inputs: [], consumes: {}, consumedFingerprint: undefined };
  const proof = await buildSubmitProof({
    origin: ORIGIN,
    order: emptyOrder,
    path: 'result',
    value: { ok: true },
    version: 5,
    now: () => 1,
    warn: () => {},
    principalKeys: keysFor(),
    sshProcess: fakeSshProcess([]),
  });
  assert.ok(proof !== undefined);
  const verified = await dsseVerifySubmission(JSON.parse(proof), {
    async verify() {
      return { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const };
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as { consumedFingerprint: Record<string, number> };
  assert.deepEqual(record.consumedFingerprint, {});
});

test('buildSubmitProof warns once and falls back unsigned when the machine key is absent', async () => {
  const warnings: string[] = [];
  const opts = {
    origin: ORIGIN,
    order: ORDER,
    path: 'result',
    value: { ok: true },
    version: 5,
    now: () => 1,
    warn: (line: string) => warnings.push(line),
    principalKeys: {
      resolveRef: () => null,
      inspect: async () => {
        throw new Error('inspect must not run');
      },
      withSigningKey: async () => {
        throw new Error('withSigningKey must not run');
      },
    } satisfies SubmissionKeyManager,
  };
  assert.equal(await buildSubmitProof(opts), undefined);
  assert.equal(await buildSubmitProof(opts), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /without a proof/);
});

test('buildSubmitProof treats missing HOME as an absent-key fallback', async () => {
  const warnings: string[] = [];
  const proof = await buildSubmitProof({
    origin: ORIGIN,
    order: ORDER,
    path: 'result',
    value: { ok: true },
    version: 5,
    now: () => 1,
    warn: (line) => warnings.push(line),
    env: {},
  });
  assert.equal(proof, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /machine signing is unavailable/);
});
