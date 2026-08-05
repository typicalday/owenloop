import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packBundle } from '../../src/bundle/index.ts';
import {
  createBundleIngestor,
  installWorkflowBundle,
  workflowStoreStatePaths,
} from '../../src/store/index.ts';
import type {
  BundleInstallResult,
  BundleSource,
  PreCommitVerifier,
} from '../../src/store/index.ts';
import type { PackResult } from '../../src/bundle/types.ts';

export function tempDir(prefix = 'owenloop-store-fixture-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeBundleSource(args: {
  name: string;
  version?: string;
  workflow: string;
  files?: Record<string, string>;
}): string {
  const root = tempDir(`owenloop-bundle-source-${args.name}-`);
  const version = args.version ?? '1.0.0';
  const manifest = [
    'formatVersion: 1',
    'package:',
    `  name: ${args.name}`,
    `  version: ${version}`,
    'entrypoint: workflow.yaml',
    'platforms: []',
    'integrity:',
    '  algorithm: sha256',
    '  files: {}',
    'capabilities: {}',
    'lock: {}',
    '',
  ].join('\n');
  writeFileSync(join(root, 'bundle.yaml'), manifest);
  writeFileSync(join(root, 'workflow.yaml'), args.workflow);
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
  const source: BundleSource = { kind: 'file', path: join(args.sourceDir, 'fixture.wnlp') };
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
