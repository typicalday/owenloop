import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finalizeDefs, loadDefFile } from '../../../../src/defs.ts';
import {
  encodeBase64,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
} from '../../../../src/crypto/dsse.ts';
import { publicKeyDescriptor } from '../../../../src/crypto/keys.ts';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type {
  EnrollmentGrantRecord,
  GrantScope,
  RevocationRecord,
  SubmissionRecord,
} from '../../../../src/crypto/records.ts';
import { defInstructionDigest } from '../../../../src/order-resolver.ts';
import type { StepDef, WorkflowDef } from '../../../../src/types.ts';
import {
  installBundleFixture,
  tempDir,
  writeBundleSource,
} from '../../../../test/helpers/store-fixture.ts';

export interface TrustKey {
  keyPath: string;
  keyid: string;
  publicKey: string;
  principal: { kind: 'machine' | 'agent'; id: string };
}

export interface TrustFixture {
  root: TrustKey;
  producer: TrustKey;
  alternate: TrustKey;
  directory: string;
  configHome: string;
  env: Record<string, string | undefined>;
}

export interface InstalledWorkflow {
  sourceDir: string;
  objectPath: string;
  projectRoot: string;
  globalRoot: string;
  definition: WorkflowDef;
  defDigest: string;
}

export const unrestrictedScope: GrantScope = {
  pools: '*',
  labels: '*',
  namespaces: '*',
  delegation: { allowed: false },
};

function makeKey(directory: string, name: string, principal: TrustKey['principal']): TrustKey {
  const keyPath = join(directory, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], {
    stdio: 'ignore',
    timeout: 15_000,
  });
  const publicKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  return { keyPath, keyid: publicKey.keyid, publicKey: publicKey.openSshPublicKey, principal };
}

/** Make all trust roots under an injected temporary directory. */
export function makeTrustFixture(prefix = 'owenloop-launch-gate-trust-'): TrustFixture {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const configHome = join(directory, 'config');
  mkdirSync(join(configHome, '.owenloop'), { recursive: true, mode: 0o700 });

  const root = makeKey(directory, 'org-root', { kind: 'machine', id: 'org-root' });
  const producer = makeKey(directory, 'producer', { kind: 'machine', id: 'producer' });
  const alternate = makeKey(directory, 'alternate', { kind: 'agent', id: 'alternate' });
  writeFileSync(join(configHome, '.owenloop', 'org-root.pub'), root.publicKey, { mode: 0o600 });

  return {
    root,
    producer,
    alternate,
    directory,
    configHome,
    env: {
      HOME: configHome,
      OWENLOOP_NO_KEYCHAIN: '1',
    },
  };
}

/** The hermetic signer seam accepts exactly the key listed in allowed_signers. */
export function signerForPrincipal({ allowedSignersText }: { allowedSignersText: string }) {
  const parts = allowedSignersText.trim().split(/\s+/);
  const selected = publicKeyDescriptor(parts.slice(1).join(' '));
  return {
    verify: async () => ({
      keyid: selected.keyid,
      principal: parts[0] ?? 'fixture-signer',
      format: 'sshsig' as const,
    }),
  };
}

function envelope(payloadType: string, payload: unknown): string {
  return JSON.stringify({
    payloadType,
    payload: encodeBase64(Buffer.from(JSON.stringify(payload), 'utf8')),
    signatures: [{ sig: encodeBase64(Buffer.from('launch-gate-fixture-signature', 'utf8')) }],
  });
}

export function grantEnvelope(
  child: TrustKey,
  grantedBy: string,
  scope: GrantScope = unrestrictedScope,
  validFrom = 0,
): string {
  const record: EnrollmentGrantRecord = {
    newKey: {
      keyid: child.keyid,
      keyType: 'ssh-ed25519',
      openSshPublicKey: child.publicKey,
      comment: child.principal.id,
    },
    principal: child.principal,
    scope,
    grantedBy,
    validFrom,
  };
  return envelope(PAYLOAD_TYPE_ENROLLMENT_GRANT, record);
}

export function revocationEnvelope(args: {
  revoked: TrustKey;
  revokedBy: string;
  effectiveFrom: number;
  issuedAt?: number;
}): string {
  const issuedAt = args.issuedAt ?? args.effectiveFrom;
  const record: RevocationRecord = {
    revokedKey: args.revoked.keyid,
    principal: args.revoked.principal,
    revokedBy: args.revokedBy,
    issuedAt,
    effectiveFrom: args.effectiveFrom,
    backdated: args.effectiveFrom < issuedAt,
  };
  return envelope(PAYLOAD_TYPE_REVOCATION, record);
}

export function submissionProof(args: {
  artifact: string;
  value: unknown;
  producer: TrustKey;
  version?: number;
  run?: string;
  workflow?: string;
  step?: string;
}): string {
  const producerKeyId = args.producer.keyid;
  const record: SubmissionRecord = {
    run: args.run ?? 'run-launch-gate',
    workflow: args.workflow ?? 'wf-launch-gate',
    defDigest: 'launch-gate-definition',
    step: args.step ?? 'producer',
    key: 'producer-key',
    produced: [{
      artifact: args.artifact,
      version: args.version ?? 1,
      valueDigest: valueDigestHex(args.value),
    }],
    consumedFingerprint: {},
    producerKeyId,
    timestamp: 10,
  };
  return envelope(PAYLOAD_TYPE_SUBMISSION, record);
}

export function installProducerGrant(fixture: TrustFixture, scope: GrantScope = unrestrictedScope): void {
  const grants = join(fixture.configHome, '.owenloop', 'grants');
  mkdirSync(grants, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(grants, 'producer.grant.dsse'),
    grantEnvelope(fixture.producer, fixture.root.keyid, scope),
    { mode: 0o600 },
  );
}

export function installAlternateGrant(fixture: TrustFixture, scope: GrantScope = unrestrictedScope): void {
  const grants = join(fixture.configHome, '.owenloop', 'grants');
  mkdirSync(grants, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(grants, 'alternate.grant.dsse'),
    grantEnvelope(fixture.alternate, fixture.root.keyid, scope),
    { mode: 0o600 },
  );
}

export function installRevocation(fixture: TrustFixture, args: {
  revoked: TrustKey;
  revokedBy?: TrustKey;
  effectiveFrom: number;
  issuedAt?: number;
}): void {
  const directory = join(fixture.configHome, '.owenloop', 'revocations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const revokedBy = args.revokedBy ?? fixture.root;
  writeFileSync(
    join(directory, `${args.revoked.principal.id}.revocation.dsse`),
    revocationEnvelope({
      revoked: args.revoked,
      revokedBy: revokedBy.keyid,
      effectiveFrom: args.effectiveFrom,
      ...(args.issuedAt === undefined ? {} : { issuedAt: args.issuedAt }),
    }),
    { mode: 0o600 },
  );
}

export async function installWorkflow(args: {
  name: string;
  workflow: string;
  projectRoot?: string;
}): Promise<InstalledWorkflow> {
  const sourceDir = writeBundleSource({ name: args.name, workflow: args.workflow });
  const projectRoot = args.projectRoot ?? tempDir(`owenloop-launch-gate-project-${args.name}-`);
  const installed = await installBundleFixture({ sourceDir, root: projectRoot });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  if (definition === undefined) throw new Error(`fixture definition '${args.name}' did not finalize`);
  return {
    sourceDir,
    objectPath: installed.result.objectPath,
    projectRoot: installed.root,
    globalRoot: tempDir(`owenloop-launch-gate-global-${args.name}-`),
    definition,
    defDigest: defInstructionDigest(definition),
  };
}
