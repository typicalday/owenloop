import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { encodeBase64, PAYLOAD_TYPE_PUBLICATION } from '../src/crypto/dsse.ts';
import {
  createExecutionDefinitionVerifier,
  createPreCommitVerifier,
} from '../src/store/pre-commit-verifier.ts';
import {
  defDigest,
  StoreDefinitionVerificationError,
  workflowCoordinate,
} from '../src/store/index.ts';
import type { BundleSource } from '../src/store/install.ts';
import type { PolicyFloor } from '../src/crypto/records.ts';

const DIGEST = 'a'.repeat(64);
const KEY_BLOB = Buffer.from('pre-commit-synthetic-key');
const KEY_ID = `SHA256:${createHash('sha256').update(KEY_BLOB).digest('base64').replace(/=+$/, '')}`;
const ALLOWED = `publisher ssh-ed25519 ${KEY_BLOB.toString('base64')} fixture\n`;
const COORDINATE = workflowCoordinate({ namespace: 'acme', name: 'fixture', version: '1.0.0' });
const SOURCE: BundleSource = { kind: 'file', path: 'bundle.wnlp' };

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function signedSidecar(digest = DIGEST): Uint8Array {
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

function input(cwd: string) {
  return {
    source: SOURCE,
    coordinate: COORDINATE,
    digest: defDigest(DIGEST),
    objectDir: join(cwd, '.owenloop-staging', 'fixture'),
  };
}

function makeVerifier(args: {
  cwd: string;
  policy: 'enforce' | 'warn' | 'off';
  warn: string[];
  allowedSigners?: string;
  policyFloor?: PolicyFloor;
}) {
  const env = { XDG_CONFIG_HOME: args.cwd };
  if (args.allowedSigners !== undefined) {
    const path = join(args.cwd, 'owenloop', 'allowed_signers');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, args.allowedSigners);
  }
  return createPreCommitVerifier({
    cwd: args.cwd,
    env,
    policy: args.policy,
    ...(args.policyFloor === undefined ? {} : { policyFloor: args.policyFloor }),
    warn: (line) => args.warn.push(line),
    signerForPrincipal: ({ principal, allowedSignersText }) => {
      assert.equal(principal, 'publisher');
      assert.equal(allowedSignersText, ALLOWED);
      return {
        verify: async () => ({ keyid: KEY_ID, principal: 'publisher', format: 'sshsig' as const }),
      };
    },
  });
}

for (const policy of ['enforce', 'warn', 'off'] as const) {
  test(`install policy: unsigned definition follows defPolicy=${policy}`, async () => {
    const cwd = temp('owenloop-precommit-unsigned-');
    const warnings: string[] = [];
    const verifier = makeVerifier({ cwd, policy, warn: warnings });
    const outcome = verifier.verify(input(cwd));
    if (policy === 'enforce') {
      await assert.rejects(outcome, (error: unknown) => {
        assert.ok(error instanceof StoreDefinitionVerificationError);
        assert.equal(error.verdict, 'unsigned');
        assert.equal(error.policy, 'enforce');
        return true;
      });
      assert.deepEqual(warnings, []);
    } else {
      await outcome;
      if (policy === 'warn') {
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /unsigned/);
      } else {
        assert.deepEqual(warnings, []);
      }
    }
  });
}

for (const policy of ['enforce', 'warn', 'off'] as const) {
  test(`install policy: unverifiable definition follows defPolicy=${policy}`, async () => {
    const cwd = temp('owenloop-precommit-unverifiable-');
    writeFileSync(join(cwd, 'bundle.wnlp.dsse'), signedSidecar());
    const warnings: string[] = [];
    const verifier = makeVerifier({ cwd, policy, warn: warnings });
    const outcome = verifier.verify(input(cwd));
    if (policy === 'enforce') {
      await assert.rejects(outcome, (error: unknown) => {
        assert.ok(error instanceof StoreDefinitionVerificationError);
        assert.equal(error.verdict, 'unverifiable');
        return true;
      });
      assert.deepEqual(warnings, []);
    } else {
      await outcome;
      if (policy === 'warn') {
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /unverifiable/);
      } else {
        assert.deepEqual(warnings, []);
      }
    }
  });
}

for (const policy of ['enforce', 'warn', 'off'] as const) {
  test(`install policy: invalid definition refuses under defPolicy=${policy}`, async () => {
    const cwd = temp('owenloop-precommit-invalid-');
    writeFileSync(join(cwd, 'bundle.wnlp.dsse'), Buffer.from('{'));
    const warnings: string[] = [];
    const verifier = makeVerifier({ cwd, policy, warn: warnings, allowedSigners: ALLOWED });
    await assert.rejects(verifier.verify(input(cwd)), (error: unknown) => {
      assert.ok(error instanceof StoreDefinitionVerificationError);
      assert.equal(error.verdict, 'invalid');
      assert.equal(error.policy, policy);
      return true;
    });
    assert.deepEqual(warnings, []);
  });
}

test('install policy: verified definition proceeds and relative sidecars resolve from injected cwd', async () => {
  const cwd = temp('owenloop-precommit-verified-');
  writeFileSync(join(cwd, 'bundle.wnlp.dsse'), signedSidecar());
  const warnings: string[] = [];
  const verifier = makeVerifier({ cwd, policy: 'enforce', warn: warnings, allowedSigners: ALLOWED });
  await verifier.verify(input(cwd));
  assert.deepEqual(warnings, []);
});

test('install policy: contradictory sidecars are invalid at every policy', async () => {
  for (const policy of ['enforce', 'warn', 'off'] as const) {
    const cwd = temp(`owenloop-precommit-contradictory-${policy}-`);
    writeFileSync(join(cwd, 'bundle.wnlp.dsse'), signedSidecar());
    writeFileSync(join(cwd, 'bundle.wnlp.unsigned'), '{}');
    const warnings: string[] = [];
    const verifier = makeVerifier({ cwd, policy, warn: warnings, allowedSigners: ALLOWED });
    await assert.rejects(verifier.verify(input(cwd)), (error: unknown) => {
      assert.ok(error instanceof StoreDefinitionVerificationError);
      assert.equal(error.verdict, 'invalid');
      return true;
    });
    assert.deepEqual(warnings, []);
  }
});

test('install policy: exact signed evidence is retained outside the object and re-verified at execution', async () => {
  const cwd = temp('owenloop-precommit-evidence-');
  const sidecar = signedSidecar();
  writeFileSync(join(cwd, 'bundle.wnlp.dsse'), sidecar);
  const warnings: string[] = [];
  const verifier = makeVerifier({ cwd, policy: 'enforce', warn: warnings, allowedSigners: ALLOWED });
  await verifier.verify(input(cwd));

  const evidencePath = join(cwd, '.owenloop', 'publications', `${DIGEST}.dsse`);
  assert.deepEqual(readFileSync(evidencePath), sidecar);
  assert.deepEqual(warnings, []);

  const execution = createExecutionDefinitionVerifier({
    env: { XDG_CONFIG_HOME: cwd },
    signerForPrincipal: ({ principal, allowedSignersText }) => {
      assert.equal(principal, 'publisher');
      assert.equal(allowedSignersText, ALLOWED);
      return {
        verify: async () => ({ keyid: KEY_ID, principal: 'publisher', format: 'sshsig' as const }),
      };
    },
  });
  const objectPath = join(cwd, 'objects', 'sha256', DIGEST);
  assert.deepEqual(await execution({ bundleDigest: DIGEST, objectPath }), {
    kind: 'verified',
    publisherKeyId: KEY_ID,
    principal: 'publisher',
  });

  writeFileSync(join(cwd, 'owenloop', 'allowed_signers'), 'malformed trust root');
  const afterTrustRootChange = await execution({ bundleDigest: DIGEST, objectPath });
  assert.equal(afterTrustRootChange.kind, 'unverifiable');
  assert.deepEqual(readFileSync(evidencePath), sidecar);
});

test('install policy floor raises local off to enforce for unsigned definitions', async () => {
  const cwd = temp('owenloop-precommit-floor-enforce-');
  const warnings: string[] = [];
  const verifier = makeVerifier({
    cwd,
    policy: 'off',
    warn: warnings,
    policyFloor: {
      trustMode: 'strict',
      unsignedDefs: 'refuse',
      unsignedArtifacts: 'refuse',
      originRules: 'enforced',
    },
  });
  await assert.rejects(verifier.verify(input(cwd)), (error: unknown) => {
    assert.ok(error instanceof StoreDefinitionVerificationError);
    assert.equal(error.verdict, 'unsigned');
    assert.equal(error.policy, 'enforce');
    return true;
  });
  assert.deepEqual(warnings, []);
});

test('install policy floor cannot lower an already-enforced local policy', async () => {
  const cwd = temp('owenloop-precommit-floor-monotone-');
  const warnings: string[] = [];
  const verifier = makeVerifier({
    cwd,
    policy: 'enforce',
    warn: warnings,
    policyFloor: {
      trustMode: 'seamless',
      unsignedDefs: 'warn',
      unsignedArtifacts: 'warn',
      originRules: 'advisory',
    },
  });
  await assert.rejects(verifier.verify(input(cwd)), (error: unknown) => {
    assert.ok(error instanceof StoreDefinitionVerificationError);
    assert.equal(error.verdict, 'unsigned');
    assert.equal(error.policy, 'enforce');
    return true;
  });
  assert.deepEqual(warnings, []);
});
