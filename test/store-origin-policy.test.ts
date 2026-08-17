import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { encodeBase64, PAYLOAD_TYPE_ORIGIN, PAYLOAD_TYPE_PUBLICATION } from '../src/crypto/dsse.ts';
import { keyidFromBlob } from '../src/crypto/keys.ts';
import {
  createExecutionOriginVerifier,
  createPreCommitVerifier,
} from '../src/store/pre-commit-verifier.ts';
import {
  defDigest,
  StoreOriginPolicyError,
  workflowCoordinate,
} from '../src/store/index.ts';
import type { BundleSource } from '../src/store/install.ts';

const DIGEST = 'b'.repeat(64);
const KEY_BLOB = Buffer.from('origin-policy-synthetic-key');
const KEY_ID = keyidFromBlob(KEY_BLOB);
const ALLOWED = `publisher ssh-ed25519 ${KEY_BLOB.toString('base64')} fixture\n`;
const COORDINATE = workflowCoordinate({ namespace: 'prod', name: 'fixture', version: '1.0.0' });
const SOURCE: BundleSource = { kind: 'file', path: 'bundle.wnlp' };

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function publicationSidecar(digest = DIGEST): Uint8Array {
  const payload = Buffer.from(JSON.stringify({
    digest,
    name: 'fixture',
    version: '1.0.0',
    publisherKeyId: KEY_ID,
    timestamp: 0,
  }));
  return Buffer.from(JSON.stringify({
    payloadType: PAYLOAD_TYPE_PUBLICATION,
    payload: encodeBase64(payload),
    signatures: [{ sig: encodeBase64(Buffer.from('signature')) }],
  }));
}

function originSidecar(kind: 'git' | 'console' | 'agent'): Uint8Array {
  const source = kind === 'git'
    ? { kind: 'git', repo: 'https://example.test/repo', commit: 'a'.repeat(40) }
    : kind === 'console'
      ? { kind: 'console', user: 'operator' }
      : { kind: 'agent', agent: 'builder', session: 'session-1' };
  const payload = Buffer.from(JSON.stringify({
    digest: DIGEST,
    name: 'fixture',
    version: '1.0.0',
    source,
    attesterKeyId: KEY_ID,
    timestamp: 0,
  }));
  return Buffer.from(JSON.stringify({
    payloadType: PAYLOAD_TYPE_ORIGIN,
    payload: encodeBase64(payload),
    signatures: [{ sig: encodeBase64(Buffer.from('signature')) }],
  }));
}

function setup(cwd: string, allowedSigners = ALLOWED): void {
  const config = join(cwd, '.owenloop');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'allowed_signers'), allowedSigners);
}

function installInput(cwd: string, source: BundleSource = SOURCE) {
  return {
    source,
    coordinate: COORDINATE,
    digest: defDigest(DIGEST),
    objectDir: join(cwd, '.owenloop-staging', 'fixture'),
  };
}

async function originError(promise: Promise<void>): Promise<StoreOriginPolicyError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof StoreOriginPolicyError);
  return caught;
}

function verifier(cwd: string, options: {
  originPolicy?: 'enforce' | 'warn' | 'off';
  originRules?: Record<string, 'git' | 'console' | 'agent' | 'any'>;
  policy?: 'enforce' | 'warn' | 'off';
  warn?: string[];
  allowed?: string;
} = {}) {
  if (options.allowed !== '') setup(cwd, options.allowed ?? ALLOWED);
  return createPreCommitVerifier({
    cwd,
    env: { HOME: cwd },
    policy: options.policy ?? 'off',
    ...(options.originPolicy === undefined ? {} : { originPolicy: options.originPolicy }),
    originRules: options.originRules ?? { prod: 'git' },
    warn: (line) => options.warn?.push(line),
    signerForPrincipal: ({ principal, allowedSignersText }) => {
      assert.equal(principal, 'publisher');
      assert.equal(allowedSignersText, ALLOWED);
      return {
        verify: async () => ({ keyid: KEY_ID, principal: 'publisher', format: 'sshsig' as const }),
      };
    },
  });
}

for (const sourceKind of ['console', 'agent'] as const) {
  test(`origin policy requiring git refuses weaker ${sourceKind} provenance`, async () => {
    const cwd = temp(`owenloop-origin-${sourceKind}-`);
    writeFileSync(join(cwd, 'bundle.wnlp.dsse'), publicationSidecar());
    const sidecarPath = join(cwd, 'bundle.wnlp.origin.dsse');
    writeFileSync(sidecarPath, originSidecar(sourceKind));
    const error = await originError(verifier(cwd, { originPolicy: 'enforce' }).verify(installInput(cwd)));
    assert.equal(error.verdict, 'weaker');
    assert.match(error.message, /originRules=prod/);
    assert.match(error.message, new RegExp(sourceKind));
  });
}

test('origin evidence is retained and re-verified at execution', async () => {
  const cwd = temp('owenloop-origin-evidence-');
  writeFileSync(join(cwd, 'bundle.wnlp.dsse'), publicationSidecar());
  const sidecar = originSidecar('git');
  writeFileSync(join(cwd, 'bundle.wnlp.origin.dsse'), sidecar);
  await verifier(cwd, { originPolicy: 'enforce' }).verify(installInput(cwd));

  const evidencePath = join(cwd, '.owenloop', 'origins', `${DIGEST}.dsse`);
  assert.deepEqual(readFileSync(evidencePath), sidecar);
  const execution = createExecutionOriginVerifier({
    env: { HOME: cwd },
    signerForPrincipal: ({ principal, allowedSignersText }) => {
      assert.equal(principal, 'publisher');
      assert.equal(allowedSignersText, ALLOWED);
      return { verify: async () => ({ keyid: KEY_ID, principal, format: 'sshsig' as const }) };
    },
  });
  const result = await execution({ bundleDigest: DIGEST, objectPath: join(cwd, 'objects', 'sha256', DIGEST) });
  assert.equal(result.kind, 'verified');
  if (result.kind === 'verified') assert.equal(result.source.kind, 'git');
});

test('absent, unverifiable, and invalid origin verdicts remain distinguishable', async () => {
  const absentCwd = temp('owenloop-origin-absent-');
  writeFileSync(join(absentCwd, 'bundle.wnlp.dsse'), publicationSidecar());
  const absentError = await originError(verifier(absentCwd, { originPolicy: 'enforce' }).verify(installInput(absentCwd)));
  assert.equal(absentError.verdict, 'absent');
  assert.match(absentError.message, /no origin was recorded/);

  const unverifiableCwd = temp('owenloop-origin-unverifiable-');
  writeFileSync(join(unverifiableCwd, 'bundle.wnlp.dsse'), publicationSidecar());
  writeFileSync(join(unverifiableCwd, 'bundle.wnlp.origin.dsse'), originSidecar('git'));
  const unverifiableError = await originError(verifier(unverifiableCwd, { originPolicy: 'enforce', allowed: '' }).verify(installInput(unverifiableCwd)));
  assert.equal(unverifiableError.verdict, 'unverifiable');
  assert.match(unverifiableError.message, /trust root|allowed_signers/);

  const invalidCwd = temp('owenloop-origin-invalid-');
  writeFileSync(join(invalidCwd, 'bundle.wnlp.dsse'), publicationSidecar());
  writeFileSync(join(invalidCwd, 'bundle.wnlp.origin.dsse'), Buffer.from('{'));
  const invalidError = await originError(verifier(invalidCwd, { originPolicy: 'off' }).verify(installInput(invalidCwd)));
  assert.equal(invalidError.verdict, 'invalid');
  assert.match(invalidError.message, /not valid JSON/);
});

test('origin wording distinguishes unsigned, non-file, and signed-file absence', async () => {
  const unsignedCwd = temp('owenloop-origin-wording-unsigned-');
  const unsignedError = await originError(verifier(unsignedCwd, { originPolicy: 'enforce' }).verify(installInput(unsignedCwd)));
  assert.match(unsignedError.message, /cannot carry an origin: the definition was published unsigned/);

  const urlCwd = temp('owenloop-origin-wording-url-');
  const urlError = await originError(verifier(urlCwd, { originPolicy: 'enforce' }).verify(installInput(urlCwd, { kind: 'url', url: 'https://example.test/bundle.wnlp' })));
  assert.match(urlError.message, /cannot carry an origin: installed from a non-file source/);

  const signedFileCwd = temp('owenloop-origin-wording-signed-');
  setup(signedFileCwd);
  writeFileSync(join(signedFileCwd, 'bundle.wnlp.dsse'), publicationSidecar());
  const signedFileError = await originError(verifier(signedFileCwd, { originPolicy: 'enforce' }).verify(installInput(signedFileCwd)));
  assert.match(signedFileError.message, /no origin was recorded/);
});
