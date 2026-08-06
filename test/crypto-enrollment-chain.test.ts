import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DSSE_SSH_NAMESPACE,
  dsseSignEnrollmentGrant,
  encodeBase64,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_REVOCATION,
} from '../src/crypto/dsse.ts';
import { keyidFromBlob, publicKeyDescriptor } from '../src/crypto/keys.ts';
import { createSshSigner } from '../src/crypto/ssh.ts';
import type { EnrollmentGrantRecord, GrantScope, RevocationRecord } from '../src/crypto/records.ts';
import {
  validateEnrollmentChain,
  validateProducer,
} from '../src/crypto/chain.ts';

interface FixtureKey {
  keyid: string;
  publicKey: string;
  blob: Buffer;
}

function fixtureKey(name: string): FixtureKey {
  const blob = Buffer.from(`synthetic-${name}`);
  const encoded = blob.toString('base64');
  return {
    blob,
    keyid: keyidFromBlob(blob),
    publicKey: `ssh-ed25519 ${encoded} ${name}`,
  };
}

const root = fixtureKey('root');
const intermediate = fixtureKey('intermediate');
const leaf = fixtureKey('leaf');
const rogue = fixtureKey('rogue');

const rootScope: GrantScope = {
  pools: '*',
  labels: '*',
  namespaces: '*',
  delegation: { allowed: true, maxDepth: 'unbounded' },
};
const intermediateScope: GrantScope = {
  pools: ['marketing'],
  labels: ['billing'],
  namespaces: ['default'],
  delegation: { allowed: true, maxDepth: 1 },
};
const leafScope: GrantScope = {
  pools: ['marketing'],
  labels: ['billing'],
  namespaces: ['default'],
  delegation: { allowed: false },
};

function sshKeygenWorks(): boolean {
  try {
    execFileSync('ssh-keygen', ['-Y', 'find-principals'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch (error) {
    return typeof (error as { status?: unknown }).status === 'number';
  }
}

const OPENSSH_SKIP = !sshKeygenWorks() && 'host ssh-keygen lacks -Y support';

function makeOpenSshKey(dir: string, name: string): { keyPath: string; publicKey: string; keyid: string } {
  const keyPath = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'owenloop-chain-test', '-f', keyPath], {
    stdio: 'ignore',
    timeout: 15_000,
  });
  const descriptor = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  return { keyPath, publicKey: descriptor.openSshPublicKey, keyid: descriptor.keyid };
}

function grant(
  key: FixtureKey,
  principal: { kind: 'human' | 'machine' | 'agent'; id: string },
  grantedBy: string,
  scope: GrantScope,
  validFrom = 0,
): Uint8Array {
  const record: EnrollmentGrantRecord = {
    newKey: {
      keyid: key.keyid,
      keyType: 'ssh-ed25519',
      openSshPublicKey: key.publicKey,
      comment: key.publicKey.split(' ')[2],
    },
    principal,
    scope,
    grantedBy,
    validFrom,
  };
  return envelope(PAYLOAD_TYPE_ENROLLMENT_GRANT, record);
}

function revocation(record: RevocationRecord): Uint8Array {
  return envelope(PAYLOAD_TYPE_REVOCATION, record);
}

function envelope(payloadType: string, record: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(record));
  return Buffer.from(JSON.stringify({
    payloadType,
    payload: encodeBase64(payload),
    signatures: [{ sig: encodeBase64(Buffer.from('synthetic-signature')) }],
  }));
}

function validGrants(): Uint8Array[] {
  return [
    grant(intermediate, { kind: 'machine', id: 'intermediate' }, root.keyid, intermediateScope),
    grant(leaf, { kind: 'agent', id: 'leaf' }, intermediate.keyid, leafScope),
  ];
}

function fakeOptions(calls: Array<{ principal: string; allowed: string }>, returnedKeyId?: string) {
  return {
    namespace: DSSE_SSH_NAMESPACE,
    signerForPrincipal: ({ principal, allowedSignersText }: { principal: string; allowedSignersText: string }) => {
      const lines = allowedSignersText.trimEnd().split('\n');
      assert.equal(lines.length, 1, 'each signer gets one allowed_signers entry');
      const parts = lines[0]!.split(/\s+/);
      assert.equal(parts.length >= 3, true);
      const parentPublicKey = parts.slice(1).join(' ');
      const parentDescriptor = publicKeyDescriptor(parentPublicKey);
      assert.equal(allowedSignersText, `${principal} ${parentDescriptor.openSshPublicKey}\n`);
      calls.push({ principal, allowed: parentDescriptor.keyid });
      return {
        verify: async () => ({
          keyid: returnedKeyId ?? parentDescriptor.keyid,
          principal,
          format: 'sshsig' as const,
        }),
      };
    },
  };
}

function chainInput(overrides: Partial<Parameters<typeof validateEnrollmentChain>[0]> = {}) {
  return {
    targetKeyId: leaf.keyid,
    orgRootPublicKey: root.publicKey,
    grants: validGrants(),
    at: 100,
    ...overrides,
  };
}

test('a valid root-to-intermediate-to-leaf chain verifies each link against exactly its parent key', async () => {
  const calls: Array<{ principal: string; allowed: string }> = [];
  const verdict = await validateEnrollmentChain(chainInput(), fakeOptions(calls));
  assert.deepEqual(verdict, {
    kind: 'verified',
    keyid: leaf.keyid,
    principal: { kind: 'agent', id: 'leaf' },
    effectiveScope: leafScope,
    depth: 2,
  });
  assert.deepEqual(calls.map((call) => call.allowed), [intermediate.keyid, root.keyid]);
  assert.deepEqual(calls.map((call) => call.principal), ['machine:intermediate', 'org-root']);
});

test('OpenSSH interoperability verifies a real root-to-intermediate-to-leaf chain', { skip: OPENSSH_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-chain-ssh-'));
  const rootKey = makeOpenSshKey(dir, 'root');
  const intermediateKey = makeOpenSshKey(dir, 'intermediate');
  const leafKey = makeOpenSshKey(dir, 'leaf');
  const rootSigner = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: rootKey.keyPath });
  const intermediateSigner = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: intermediateKey.keyPath });
  try {
    const makeRecord = (
      key: { keyid: string; publicKey: string },
      principal: { kind: 'machine' | 'agent'; id: string },
      grantedBy: string,
      scope: GrantScope,
    ): EnrollmentGrantRecord => ({
      newKey: { keyid: key.keyid, keyType: 'ssh-ed25519', openSshPublicKey: key.publicKey },
      principal,
      scope,
      grantedBy,
      validFrom: 0,
    });
    const intermediateGrant = await dsseSignEnrollmentGrant(
      Buffer.from(JSON.stringify(makeRecord(intermediateKey, { kind: 'machine', id: 'intermediate' }, rootKey.keyid, intermediateScope))),
      rootSigner,
    );
    const leafGrant = await dsseSignEnrollmentGrant(
      Buffer.from(JSON.stringify(makeRecord(leafKey, { kind: 'agent', id: 'leaf' }, intermediateKey.keyid, leafScope))),
      intermediateSigner,
    );
    const allowedEntries: string[] = [];
    const verdict = await validateEnrollmentChain(
      {
        targetKeyId: leafKey.keyid,
        orgRootPublicKey: rootKey.publicKey,
        grants: [
          Buffer.from(JSON.stringify(intermediateGrant.envelope)),
          Buffer.from(JSON.stringify(leafGrant.envelope)),
        ],
        at: 100,
      },
      {
        signerForPrincipal: ({ principal, allowedSignersText }) => {
          allowedEntries.push(`${principal} ${allowedSignersText}`);
          return createSshSigner({
            namespace: DSSE_SSH_NAMESPACE,
            verify: { principal, allowedSignersText },
          });
        },
      },
    );
    assert.equal(verdict.kind, 'verified');
    assert.equal(verdict.keyid, leafKey.keyid);
    assert.deepEqual(allowedEntries.map((entry) => entry.split(' ')[0]), ['machine:intermediate', 'org-root']);
  } finally {
    rootSigner.dispose();
    intermediateSigner.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hub vouch does not make a rogue roster entry trusted without a root-terminating chain', async () => {
  const hub = { hubSaysTrusted: true, roster: [rogue.keyid] };
  assert.equal(hub.hubSaysTrusted, true);
  const rogueGrant = grant(rogue, { kind: 'machine', id: 'rogue' }, intermediate.keyid, intermediateScope);
  const verdict = await validateEnrollmentChain(
    chainInput({ targetKeyId: rogue.keyid, grants: [rogueGrant] }),
    fakeOptions([]),
  );
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.reason, /does not terminate at the org root|has no grant/);
});

test('producer scope demand is rejected by attenuation arithmetic for hr-software', async () => {
  const verdict = await validateProducer(
    { ...chainInput({ targetKeyId: intermediate.keyid }), demand: { label: 'hr-software' } },
    fakeOptions([]),
  );
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.reason, /label 'hr-software' is outside the granted scope/);
});

test('revoking an intermediate cascades to the leaf, while a pre-cut artifact remains valid', async () => {
  const cuts = [revocation({
    revokedKey: intermediate.keyid,
    principal: { kind: 'machine', id: 'intermediate' },
    revokedBy: root.keyid,
    issuedAt: 100,
    effectiveFrom: 100,
    backdated: false,
  })];
  const before = await validateEnrollmentChain(chainInput({ at: 99, revocations: cuts }), fakeOptions([]));
  assert.equal(before.kind, 'verified');
  const after = await validateEnrollmentChain(chainInput({ at: 100, revocations: cuts }), fakeOptions([]));
  assert.equal(after.kind, 'invalid');
  assert.match(after.reason, /contains revoked key/);
});

test('backdated revocation is root-only and accepted root cuts are conspicuously reported', async () => {
  const notes: string[] = [];
  const rootCut = revocation({
    revokedKey: leaf.keyid,
    principal: { kind: 'agent', id: 'leaf' },
    revokedBy: root.keyid,
    issuedAt: 100,
    effectiveFrom: 50,
    backdated: true,
  });
  const accepted = await validateEnrollmentChain(
    chainInput({ revocations: [rootCut] }),
    { ...fakeOptions([]), onBackdatedRevocation: (note: string) => notes.push(note) },
  );
  assert.equal(accepted.kind, 'invalid');
  assert.match(accepted.reason, /contains revoked key/);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /accepted backdated revocation/);

  const nonRootCut = revocation({
    revokedKey: leaf.keyid,
    principal: { kind: 'agent', id: 'leaf' },
    revokedBy: intermediate.keyid,
    issuedAt: 200,
    effectiveFrom: 150,
    backdated: true,
  });
  const rejected = await validateEnrollmentChain(chainInput({ revocations: [nonRootCut] }), fakeOptions([]));
  assert.equal(rejected.kind, 'invalid');
  assert.match(rejected.reason, /must be signed by the org root/);
});

test('temporal inconsistency is rejected before a revocation signer is constructed', async () => {
  const calls: Array<{ principal: string; allowed: string }> = [];
  const inconsistent = revocation({
    revokedKey: leaf.keyid,
    principal: { kind: 'agent', id: 'leaf' },
    revokedBy: root.keyid,
    issuedAt: 100,
    effectiveFrom: 100,
    backdated: true,
  });
  const verdict = await validateEnrollmentChain(chainInput({ revocations: [inconsistent] }), fakeOptions(calls));
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.reason, /inconsistent backdated flag/);
  assert.equal(calls.length, 2, 'grant links are checked; the inconsistent revocation is not cryptographically attempted');
});

test('root target needs no grant and missing local anchor is unverifiable', async () => {
  const rootVerdict = await validateEnrollmentChain(chainInput({ targetKeyId: root.keyid, grants: [] }), fakeOptions([]));
  assert.deepEqual(rootVerdict, {
    kind: 'verified',
    keyid: root.keyid,
    principal: { kind: 'human', id: 'org-root' },
    effectiveScope: rootScope,
    depth: 0,
  });
  const missing = await validateEnrollmentChain(chainInput({ orgRootPublicKey: '' }), fakeOptions([]));
  assert.equal(missing.kind, 'unverifiable');
});

test('schema failures, returned signer mismatches, cycles, and depth caps are named invalid decisions', async () => {
  const malformed = Buffer.from(JSON.stringify({ payloadType: PAYLOAD_TYPE_ENROLLMENT_GRANT, payload: encodeBase64(Buffer.from('{"extra":true}')), signatures: [] }));
  const malformedVerdict = await validateEnrollmentChain(chainInput({ grants: [malformed] }), fakeOptions([]));
  assert.equal(malformedVerdict.kind, 'invalid');
  assert.match(malformedVerdict.reason, /does not match schema/);

  const mismatch = await validateEnrollmentChain(chainInput(), fakeOptions([], root.keyid));
  assert.equal(mismatch.kind, 'invalid');
  assert.match(mismatch.reason, /expected parent/);

  const cycleScope: GrantScope = {
    pools: ['marketing'],
    labels: ['billing'],
    namespaces: ['default'],
    delegation: { allowed: true, maxDepth: 'unbounded' },
  };
  const cyclic = [
    grant(intermediate, { kind: 'machine', id: 'intermediate' }, leaf.keyid, cycleScope),
    grant(leaf, { kind: 'agent', id: 'leaf' }, intermediate.keyid, cycleScope),
  ];
  const cycleVerdict = await validateEnrollmentChain(chainInput({ grants: cyclic }), fakeOptions([]));
  assert.equal(cycleVerdict.kind, 'invalid');
  assert.match(cycleVerdict.reason, /cycle/);

  const capped = await validateEnrollmentChain(chainInput(), { ...fakeOptions([]), maxChainDepth: 1 });
  assert.equal(capped.kind, 'invalid');
  assert.match(capped.reason, /maxChainDepth/);
});
