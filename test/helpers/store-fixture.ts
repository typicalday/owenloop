import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { packBundle } from '../../src/bundle/index.ts';
import { canonicalJsonBytes } from '../../src/install.ts';
import { DSSE_SSH_NAMESPACE, dsseSignPublication } from '../../src/crypto/dsse.ts';
import { createSshSigner } from '../../src/crypto/ssh.ts';
import { publicKeyDescriptor } from '../../src/crypto/keys.ts';
import {
  createBundleIngestor,
  installWorkflowBundle,
  workflowStoreStatePaths,
} from '../../src/store/index.ts';
import {
  createPreCommitVerifier,
  type BundleInstallResult,
  type BundleSource,
  type PreCommitVerifier,
} from '../../src/store/index.ts';
import type { PackResult } from '../../src/bundle/types.ts';

export function tempDir(prefix = 'owenloop-store-fixture-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeBundleSource(args: {
  name: string;
  version?: string;
  workflow: string;
  /** Optional already-indented runtime member lines (without the `runtime:` key). */
  runtimeYaml?: string;
  /** Additional workflow name to YAML content entries, stored at the root. */
  workflows?: Record<string, string>;
  /** Explicit callable workflow for the installed versioned coordinate. */
  defaultWorkflow?: string;
  /** Explicit versioned calls targets pinned to bundle digests. */
  lock?: Record<string, string>;
  files?: Record<string, string>;
}): string {
  const root = tempDir(`owenloop-bundle-source-${args.name}-`);
  const version = args.version ?? '1.0.0';
  const workflowContents = { [args.name]: args.workflow, ...(args.workflows ?? {}) };
  const manifest = [
    'formatVersion: 2',
    'package:',
    `  name: ${args.name}`,
    `  version: ${version}`,
    ...(args.runtimeYaml === undefined
      ? []
      : ['runtime:', ...args.runtimeYaml.split('\n').map((line) => `  ${line}`)]),
    'workflows:',
    ...Object.keys(workflowContents).map((name) => `  ${name}: ${JSON.stringify(name === args.name ? 'workflow.yaml' : `${name}.yaml`)}`),
    ...(args.defaultWorkflow === undefined ? [] : [`default: ${JSON.stringify(args.defaultWorkflow)}`]),
    'platforms: []',
    'integrity:',
    '  algorithm: sha256',
    '  files: {}',
    'capabilities: {}',
    ...(args.lock === undefined || Object.keys(args.lock).length === 0
      ? ['lock: {}']
      : ['lock:', ...Object.entries(args.lock).map(([target, digest]) => `  ${JSON.stringify(target)}: ${JSON.stringify(digest)}`)]),
    '',
  ].join('\n');
  writeFileSync(join(root, 'bundle.yaml'), manifest);
  for (const [name, content] of Object.entries(workflowContents)) {
    writeFileSync(join(root, name === args.name ? 'workflow.yaml' : `${name}.yaml`), content);
  }
  for (const [relative, content] of Object.entries(args.files ?? {})) {
    const target = join(root, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

export async function installBundleFixture(args: {
  sourceDir: string;
  root?: string;
  sourcePath?: string;
  verifier?: PreCommitVerifier;
}): Promise<{
  source: BundleSource;
  packed: PackResult;
  result: BundleInstallResult;
  root: string;
}> {
  const root = args.root ?? tempDir('owenloop-store-root-');
  const packed = packBundle(args.sourceDir);
  const state = workflowStoreStatePaths(root);
  const markerDir = tempDir('owenloop-store-markers-');
  const source: BundleSource = {
    kind: 'file',
    path: args.sourcePath ?? join(args.sourceDir, 'fixture.wnlp'),
  };
  const verifier = args.verifier ?? { verify: async (): Promise<void> => {} };
  const result = await installWorkflowBundle({
    bytes: packed.bytes,
    source,
    root,
    level: 'project',
    lockPath: state.lockPath,
    journalPath: state.journalPath,
    recoveryMarkerDir: markerDir,
    ingestor: createBundleIngestor(),
    verifier,
  });
  return { source, packed, result, root };
}

/**
 * Install a bundle with real publication evidence so a spawned production
 * worker can re-verify the definition after crossing the process boundary.
 * The key and sidecars are throwaway fixture data and are removed with the
 * caller's temporary root.
 */
export async function installSignedBundleFixture(args: {
  sourceDir: string;
  root: string;
  home: string;
  configHome?: string;
  env?: Record<string, string | undefined>;
}): Promise<{
  source: BundleSource;
  packed: PackResult;
  result: BundleInstallResult;
  root: string;
  env: Record<string, string | undefined>;
}> {
  const packed = packBundle(args.sourceDir);
  mkdirSync(args.root, { recursive: true, mode: 0o700 });
  const sourcePath = join(args.root, `${basename(args.sourceDir)}.fixture.wnlp`);
  writeFileSync(sourcePath, packed.bytes, { mode: 0o600 });

  const keyPath = join(args.root, `${basename(args.sourceDir)}.fixture-key`);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'ignore' });
  const publicKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  const principal = 'fixture-publisher';
  const configHome = args.configHome ?? args.home;
  const allowedDir = join(configHome, '.owenloop');
  mkdirSync(allowedDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(allowedDir, 'allowed_signers'), `${principal} ${publicKey.openSshPublicKey}\n`, { mode: 0o600 });

  const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: keyPath });
  const record = {
    digest: packed.digest,
    name: packed.manifest.package.name,
    version: packed.manifest.package.version,
    publisherKeyId: publicKey.keyid,
    timestamp: Date.now(),
  };
  const signed = await dsseSignPublication(Buffer.from(canonicalJsonBytes(record)), signer);
  writeFileSync(`${sourcePath}.dsse`, canonicalJsonBytes(signed.envelope), { mode: 0o600 });

  const env = {
    HOME: configHome,
    ...(args.env ?? {}),
  };
  const installed = await installBundleFixture({
    sourceDir: args.sourceDir,
    root: args.root,
    sourcePath,
    verifier: createPreCommitVerifier({ env, cwd: process.cwd() }),
  });
  return { ...installed, env };
}
