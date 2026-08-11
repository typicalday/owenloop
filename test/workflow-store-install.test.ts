/**
 * `installWorkflowBundle` / `recoverWorkflowStore` — the workflow-store trust
 * boundary exercised with FAKE adapters (the concrete bundle-format and
 * verification modules are separate; the ports are required and fail closed
 * without them). The fakes record every call so the tests pin the
 * fixed commit order, and every crash scenario is simulated by hand-crafting
 * the exact on-disk state a crash would leave.
 *
 * Fixture generation is deliberately independent of any production ingestion
 * logic: the "bundle" is plain JSON (manifest + files), and its digest is
 * computed here with node:crypto, never by the module under test.
 *
 * Hermetic: every test builds its own temp root/lock/journal under tmpdir;
 * the real ~/.owenloop is never touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BundleIngestorUnavailableError,
  createBundleIngestor,
  defDigest,
  hardenObjectModes,
  installWorkflowBundle,
  objectDestRelPath,
  PreCommitVerifierUnavailableError,
  readWorkflowStoreIndex,
  StoreIntegrityError,
  recoverWorkflowStore,
  storeIndexPath,
  verifyWorkflowObjectSync,
  waitForDigestRepair,
  workflowCoordinate,
  workflowStoreStatePaths,
} from '../src/store/index.ts';
import type {
  BundleIngestor,
  BundleSource,
  DefDigest,
  PreCommitVerifier,
  WorkflowCoordinate,
} from '../src/store/index.ts';
import { ADD_JOURNAL_FILENAME, writeAddJournal } from '../src/add.ts';
import { unpackBundle } from '../src/bundle/index.ts';
import {
  canonicalJsonBytes,
  commitInstall,
  createRecoveryMarker,
  finalizeInstallCommit,
  recordRecoveryMarkerPriorIdentity,
  removeAddJournal,
  renameDirRestoringWrite,
  rmRecursiveForce,
  rollbackInstallCommit,
  sha256Hex,
} from '../src/install.ts';
import { acquireFileLock, releaseFileLock } from '../src/lock.ts';
import { defInstructionDigest } from '../src/order-resolver.ts';
import { loadDefFile } from '../src/defs.ts';
import { installBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

// ---- independent fixture layer ---------------------------------------------------

/** A minimal-but-valid single-step workflow def (passes lint/validate/modelCheck). */
function validDefYaml(name: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: worker',
    '    consumes: [seed]',
    '    produces: [out]',
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '',
  ].join('\n');
}

interface WireManifest {
  coordinate: { namespace: string; name: string; version: string };
  files: Record<string, string>;
  /** The digest claim over `{coordinate, files}` — what a real bundle header carries. */
  claim: string;
  /** Optional names returned by the fake ingestor for multi-workflow install coverage. */
  workflows?: string[];
  /** Test convenience: equals `claim` for an untampered manifest; never serialized. */
  digest: string;
}

/** Content-digest primitive (test-owned; mirrors what A1 computes canonically). */
function sha256Content(coordinate: WireManifest['coordinate'], files: Record<string, string>): string {
  return createHash('sha256')
    .update(new TextEncoder().encode(JSON.stringify({ coordinate, files })))
    .digest('hex');
}

function makeBundle(name = 'widget', files?: Record<string, string>, workflows?: string[]): WireManifest {
  const coordinate = { namespace: 'acme', name, version: '1.0.0' };
  const f = files ?? { 'def.yaml': validDefYaml(name) };
  const digest = sha256Content(coordinate, f);
  return { coordinate, files: f, claim: digest, ...(workflows === undefined ? {} : { workflows }), digest };
}

/** Serialize the wire form: content + claim. Key order is stable (insertion order). */
function bundleBytes(m: WireManifest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      coordinate: m.coordinate,
      files: m.files,
      claim: m.claim,
      ...(m.workflows === undefined ? {} : { workflows: m.workflows }),
    }),
  );
}

/**
 * The fake A1 ingestor: parses the JSON fixture, checks the byte digest
 * against the manifest's claimed digest (the tamper gate), then unpacks the
 * files into the supplied stagingDir — returning ONLY after both checks pass,
 * mirroring the real adapter's contract. `verifyInstalledObject` records
 * calls and honours `failObjectDirs` (a set of object dirs to report corrupt).
 */
function fakeIngestor(opts: {
  failVerifyFor?: Set<string>;
  failVerify?: (input: { objectDir: string; digest: DefDigest }, call: number) => boolean;
} = {}): BundleIngestor & {
  ingests: number;
  verifies: Array<{ objectDir: string; digest: DefDigest }>;
} {
  const state = { ingests: 0, verifies: [] as Array<{ objectDir: string; digest: DefDigest }> };
  return {
    ingests: 0,
    verifies: state.verifies,
    async ingest(input: {
      source: BundleSource;
      bytes: Uint8Array;
      stagingDir: string;
    }): Promise<{ coordinate: WorkflowCoordinate; digest: DefDigest; workflows: string[] }> {
      state.ingests++;
      (this as { ingests: number }).ingests = state.ingests;
      let m: {
	coordinate: WireManifest['coordinate'];
	files: Record<string, string>;
	claim: string;
	workflows?: string[];
      };
      try {
        m = JSON.parse(new TextDecoder().decode(input.bytes));
      } catch {
        throw new Error('fake A1: bundle is not a parseable manifest');
      }
      // Tamper gate: the recomputed content digest must equal the manifest claim.
      const actual = sha256Content(m.coordinate, m.files);
      if (actual !== m.claim) {
        throw new Error(`fake A1: bundle digest mismatch — refusing (expected ${m.claim}, got ${actual})`);
      }
      const coordinate = workflowCoordinate(m.coordinate);
      mkdirSync(input.stagingDir, { recursive: true });
      for (const [rel, content] of Object.entries(m.files)) {
        const full = join(input.stagingDir, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content);
      }
      return { coordinate, digest: defDigest(m.claim), workflows: m.workflows ?? [m.coordinate.name] };
    },
    async verifyInstalledObject(input: { objectDir: string; digest: DefDigest }): Promise<void> {
      state.verifies.push(input);
      const call = state.verifies.length;
      if (opts.failVerifyFor?.has(input.objectDir) || opts.failVerify?.(input, call) === true) {
        throw new Error(`fake A1: installed object at ${input.objectDir} failed verification`);
      }
    },
  };
}

/** The fake A2 verifier: records call order; `fail` rejects the commit. */
function fakeVerifier(opts: { fail?: boolean; onVerify?: () => void } = {}): PreCommitVerifier & {
  calls: Array<{ source: BundleSource; coordinate: WorkflowCoordinate; digest: DefDigest; objectDir: string }>;
} {
  const calls: Array<{ source: BundleSource; coordinate: WorkflowCoordinate; digest: DefDigest; objectDir: string }> = [];
  return {
    calls,
    async verify(input: {
      source: BundleSource;
      coordinate: WorkflowCoordinate;
      digest: DefDigest;
      objectDir: string;
    }): Promise<void> {
      calls.push(input);
      opts.onVerify?.();
      if (opts.fail) throw new Error('fake A2: pre-commit verification refused');
    },
  };
}

/** One temp store root with its per-root lock/journal/marker paths. */
function tempStore(prefix = 'owenloop-wstore-'): {
  root: string;
  lockPath: string;
  journalPath: string;
  markerDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const markerDir = mkdtempSync(join(tmpdir(), `${prefix}markers-`));
  return {
    root,
    lockPath: join(root, '.owenloop', 'add.lock'),
    journalPath: join(root, '.owenloop', ADD_JOURNAL_FILENAME),
    markerDir,
  };
}

async function assertLockReleased(lockPath: string, message: string): Promise<void> {
  assert.equal(existsSync(lockPath), true, `${message}: persistent SQLite lock database remains`);
  const probe = await acquireFileLock(lockPath, { waitMs: 100, pollMs: 5, label: 'test workflow-store install' });
  releaseFileLock(probe);
}

const SRC: BundleSource = { kind: 'file', path: '/nonexistent/origin.wnlp' }; // origin data only — never opened by the installer

async function indexedObjectForRecovery(name: string): Promise<{
  root: string;
  lockPath: string;
  journalPath: string;
  digest: DefDigest;
  objDir: string;
  metadataHash: string;
}> {
  const { root, lockPath, journalPath, markerDir } = tempStore();
  const bundle = makeBundle(name);
  await installWorkflowBundle({
    bytes: bundleBytes(bundle), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: markerDir,
    ingestor: fakeIngestor(), verifier: fakeVerifier(),
  });
  const digest = defDigest(bundle.digest);
  return {
    root,
    lockPath,
    journalPath,
    digest,
    objDir: join(root, objectDestRelPath(digest)),
    metadataHash: sha256Hex(canonicalJsonBytes(readWorkflowStoreIndex(storeIndexPath(root)))),
  };
}

interface RealRepairFixture {
  root: string;
  lockPath: string;
  journalPath: string;
  markerDir: string;
  source: BundleSource;
  packed: Awaited<ReturnType<typeof installBundleFixture>>['packed'];
  digest: DefDigest;
  objectDir: string;
  metadataHash: string;
  executableRel: string;
  nonExecutableRel: string;
  nestedDirRel: string;
}

async function realRepairFixture(name: string): Promise<RealRepairFixture> {
  const executableRel = 'bin/run.sh';
  const nestedDirRel = 'nested/deeper';
  const nonExecutableRel = `${nestedDirRel}/note.txt`;
  const sourceDir = writeBundleSource({
    name,
    workflow: validDefYaml(name),
    files: {
      [executableRel]: '#!/bin/sh\nprintf "ok\\n"\n',
      [nonExecutableRel]: 'immutable note\n',
    },
  });
  chmodSync(join(sourceDir, executableRel), 0o755);
  const installed = await installBundleFixture({ sourceDir });
  const state = workflowStoreStatePaths(installed.root);
  return {
    root: installed.root,
    lockPath: state.lockPath,
    journalPath: state.journalPath,
    markerDir: tempDir('owenloop-repair-marker-'),
    source: installed.source,
    packed: installed.packed,
    digest: installed.result.digest,
    objectDir: installed.result.objectPath,
    metadataHash: sha256Hex(canonicalJsonBytes(readWorkflowStoreIndex(storeIndexPath(installed.root)))),
    executableRel,
    nonExecutableRel,
    nestedDirRel,
  };
}

function stageRealReplacement(fixture: RealRepairFixture, stagingId: string): string {
  const stagingDir = join(fixture.root, '.owenloop-staging', stagingId);
  mkdirSync(join(stagingDir, '..'), { recursive: true });
  unpackBundle(fixture.packed.bytes, stagingDir);
  verifyWorkflowObjectSync(stagingDir, fixture.digest, {
    coordinateRepair: false,
    requireHardenedModes: false,
  });
  return stagingDir;
}

async function durableRepairRollbackFixture(name: string) {
  const safeName = name.replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '').slice(0, 96);
  const fixture = await realRepairFixture(safeName);
  chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);
  const priorInode = statSync(fixture.objectDir).ino;
  const stagingId = `stg_${name.replaceAll(/[^a-z0-9]+/g, '_')}`;
  const stagingDir = stageRealReplacement(fixture, stagingId);
  const backupDir = `${stagingDir}-old`;
  const undoDir = `${stagingDir}-undo`;
  const marker = createRecoveryMarker({
    root: fixture.root,
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    markerDir: fixture.markerDir,
    operation: 'repair',
    replacementDir: stagingDir,
  });
  const journalBase = {
    version: 2 as const,
    phase: 'applying' as const,
    operation: 'repair' as const,
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    hadDest: true,
    root: fixture.root,
    metadataHash: fixture.metadataHash,
    recoveryMarkerId: marker.id,
  };
  writeAddJournal(fixture.journalPath, journalBase);
  const handle = commitInstall(fixture.root, objectDestRelPath(fixture.digest), stagingDir, {
    afterBackupRename: () => recordRecoveryMarkerPriorIdentity(marker, backupDir),
  });
  hardenObjectModes(handle.dest);
  return { fixture, priorInode, stagingDir, backupDir, undoDir, marker, journalBase, handle };
}

type DurableRepairRollbackFixture = Awaited<ReturnType<typeof durableRepairRollbackFixture>>;

function parkRepairReplacement(input: DurableRepairRollbackFixture): void {
  renameDirRestoringWrite(input.fixture.objectDir, input.undoDir);
}

function restoreRepairPrior(input: DurableRepairRollbackFixture): void {
  renameDirRestoringWrite(input.backupDir, input.fixture.objectDir);
}

function assertExactRestoredPrior(input: DurableRepairRollbackFixture): void {
  const { fixture } = input;
  assert.equal(statSync(fixture.objectDir).ino, input.priorInode, 'the exact prior directory inode is restored');
  assert.equal(statSync(fixture.objectDir).mode & 0o7777, 0o555, 'prior object-root mode is exactly 0555');
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nestedDirRel)).mode & 0o7777,
    0o555,
    'prior nested-directory mode is exactly 0555',
  );
  assert.equal(
    statSync(join(fixture.objectDir, fixture.executableRel)).mode & 0o7777,
    0o555,
    'prior executable-file mode is exactly 0555',
  );
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nonExecutableRel)).mode & 0o7777,
    0o644,
    'prior non-executable-file mode is restored exactly',
  );
  assert.equal(
    readFileSync(join(fixture.objectDir, fixture.nonExecutableRel), 'utf8'),
    'immutable note\n',
    'prior file content is preserved',
  );
}

function assertRollbackDebrisCleared(input: DurableRepairRollbackFixture): void {
  assert.ok(!existsSync(input.fixture.journalPath), 'rollback journal is removed');
  assert.ok(!existsSync(input.stagingDir), 'staging directory is absent');
  assert.ok(!existsSync(input.backupDir), 'retained prior backup is consumed');
  assert.ok(!existsSync(input.undoDir), 'replacement undo debris is removed');
  assert.ok(!existsSync(join(input.fixture.root, '.owenloop-staging')), 'empty staging root is removed');
  assert.ok(!existsSync(input.marker.path), 'external transaction marker is removed');
}

function assertHardenedRepairTree(fixture: RealRepairFixture): void {
  assert.equal(statSync(fixture.objectDir).mode & 0o7777, 0o555, 'object root is exactly 0555');
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nestedDirRel)).mode & 0o7777,
    0o555,
    'nested directory is exactly 0555',
  );
  assert.equal(
    statSync(join(fixture.objectDir, fixture.executableRel)).mode & 0o7777,
    0o555,
    'executable regular file is exactly 0555',
  );
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nonExecutableRel)).mode & 0o7777,
    0o444,
    'non-executable regular file is exactly 0444',
  );
  verifyWorkflowObjectSync(fixture.objectDir, fixture.digest, { coordinateRepair: false });
}

async function assertHealthyReinstallDedupesWithoutReplacement(fixture: RealRepairFixture): Promise<void> {
  const inodeBefore = statSync(fixture.objectDir).ino;
  const second = await installWorkflowBundle({
    bytes: fixture.packed.bytes,
    source: fixture.source,
    root: fixture.root,
    level: 'project',
    lockPath: fixture.lockPath,
    journalPath: fixture.journalPath,
    recoveryMarkerDir: fixture.markerDir,
    ingestor: createBundleIngestor(),
    verifier: fakeVerifier(),
  });
  assert.equal(second.installed, false, 'the recovered healthy object takes the dedupe path');
  assert.equal(statSync(fixture.objectDir).ino, inodeBefore, 'dedupe does not replace the healthy object directory');
  assertHardenedRepairTree(fixture);
}

async function assertBrokenRecoveryReinstallsAndThenDedupes(fixture: RealRepairFixture): Promise<void> {
  const brokenInode = statSync(fixture.objectDir).ino;
  const repaired = await installWorkflowBundle({
    bytes: fixture.packed.bytes,
    source: fixture.source,
    root: fixture.root,
    level: 'project',
    lockPath: fixture.lockPath,
    journalPath: fixture.journalPath,
    recoveryMarkerDir: fixture.markerDir,
    ingestor: createBundleIngestor(),
    verifier: fakeVerifier(),
  });
  assert.equal(repaired.installed, false, 'same-digest reinstall repairs the restored broken object');
  assert.notEqual(statSync(fixture.objectDir).ino, brokenInode, 'repair replaces the broken object directory');
  assertHardenedRepairTree(fixture);
  await assertHealthyReinstallDedupesWithoutReplacement(fixture);
}

const specialPermissionCases = [
  { name: 'setuid', bits: 0o4000 },
  { name: 'setgid', bits: 0o2000 },
  { name: 'sticky', bits: 0o1000 },
  { name: 'setuid and setgid', bits: 0o6000 },
  { name: 'setuid and sticky', bits: 0o5000 },
  { name: 'setgid and sticky', bits: 0o3000 },
  { name: 'setuid, setgid, and sticky', bits: 0o7000 },
] as const;

const specialPermissionTargets = [
  {
    name: 'object-root directory',
    expectedMode: 0o555,
    diagnosticKind: 'directory',
    path: (fixture: RealRepairFixture): string => fixture.objectDir,
  },
  {
    name: 'nested directory',
    expectedMode: 0o555,
    diagnosticKind: 'directory',
    path: (fixture: RealRepairFixture): string => join(fixture.objectDir, fixture.nestedDirRel),
  },
  {
    name: 'executable file',
    expectedMode: 0o555,
    diagnosticKind: 'regular file',
    path: (fixture: RealRepairFixture): string => join(fixture.objectDir, fixture.executableRel),
  },
  {
    name: 'non-executable file',
    expectedMode: 0o444,
    diagnosticKind: 'regular file',
    path: (fixture: RealRepairFixture): string => join(fixture.objectDir, fixture.nonExecutableRel),
  },
] as const;

async function assertSpecialPermissionRepair(
  fixture: RealRepairFixture,
  target: (typeof specialPermissionTargets)[number],
  permission: (typeof specialPermissionCases)[number],
): Promise<void> {
  const targetPath = target.path(fixture);
  const tamperedMode = target.expectedMode | permission.bits;
  chmodSync(targetPath, tamperedMode);
  assert.equal(
    statSync(targetPath).mode & 0o7777,
    tamperedMode,
    'the fixture carries the intended special permission bits',
  );
  assert.throws(
    () => verifyWorkflowObjectSync(fixture.objectDir, fixture.digest, { coordinateRepair: false }),
    new RegExp(`${target.diagnosticKind} mode is 0${tamperedMode.toString(8)}, expected hardened store mode`),
  );
  await assertBrokenRecoveryReinstallsAndThenDedupes(fixture);
}

for (const target of specialPermissionTargets) {
  test(`install: special permission bits on the ${target.name} fail verification and trigger repair`, async (t) => {
    const fixture = await realRepairFixture(`special-mode-${target.name.replaceAll(/[^a-z]+/g, '-')}`);

    for (const permission of specialPermissionCases) {
      await t.test(permission.name, () => assertSpecialPermissionRepair(fixture, target, permission));
    }
  });
}

// ---- the happy path and the commit order ------------------------------------------

test('install: a valid bundle installs with the fixed commit order and hardened modes', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();
  const ingestor = fakeIngestor();
  const verifier = fakeVerifier();
  const events: string[] = [];
  let a1StagingDir = '';
  // Wrap the adapters to capture the call ORDER and the exact staged tree that
  // A2 receives before the destination exists.
  const orderedIngestor: BundleIngestor = {
    async ingest(i) { a1StagingDir = i.stagingDir; events.push('a1-ingest'); return ingestor.ingest(i); },
    async verifyInstalledObject(i) { events.push('a1-verify-installed'); return ingestor.verifyInstalledObject(i); },
  };
  const orderedVerifier: PreCommitVerifier = {
    async verify(i) {
      events.push('a2-verify');
      assert.equal(i.objectDir, a1StagingDir, 'A2 receives the A1 staging directory');
      assert.ok(existsSync(i.objectDir), 'A1 staging directory exists during A2 verification');
      assert.ok(!existsSync(join(root, objectDestRelPath(defDigest(m.digest)))), 'final object is not installed during A2 verification');
      return verifier.verify(i);
    },
  };

  const result = await installWorkflowBundle({
    bytes: bundleBytes(m),
    source: SRC,
    root,
    level: 'project',
    lockPath,
    journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: orderedIngestor,
    verifier: orderedVerifier,
  });

  // Commit order: A1 stage, then A2 verify, then (harden → journal → swap → index).
  assert.deepEqual(events, ['a1-ingest', 'a2-verify']);
  assert.equal(result.installed, true);
  assert.equal(result.level, 'project');
  assert.equal(result.coordinate, 'acme/widget@1.0.0');
  assert.equal(result.digest, m.digest);
  assert.deepEqual(result.workflows, ['widget']);
  assert.equal(result.objectPath, join(root, objectDestRelPath(defDigest(m.digest))));

  // Object content + HARDENED modes (files 0o444, dirs 0o555, object dir included).
  const objDir = result.objectPath;
  const fileMode = statSync(join(objDir, 'def.yaml')).mode & 0o7777;
  const dirMode = statSync(objDir).mode & 0o7777;
  assert.equal(fileMode, 0o444, 'object files hardened read-only');
  assert.equal(dirMode, 0o555, 'object dir hardened non-writable');
  assert.equal(readFileSync(join(objDir, 'def.yaml'), 'utf8'), validDefYaml('widget'));

  // Index records the coordinate; journal is gone; the persistent lock is free; staging is cleared.
  assert.deepEqual(readWorkflowStoreIndex(storeIndexPath(root)), {
    version: 1,
    entries: { 'acme/widget@1.0.0': { digest: m.digest, pinned: false, workflows: ['widget'] } },
  });
  assert.ok(!existsSync(journalPath), 'journal removed on success');
  await assertLockReleased(lockPath, 'lock released on success');
  assert.ok(!existsSync(join(root, '.owenloop-staging')), 'staging root cleared');
});

test('install: a two-workflow bundle persists both names in index.json', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle(
    'widget',
    {
      'def.yaml': validDefYaml('widget'),
      'other.yaml': validDefYaml('other'),
    },
    ['widget', 'other'],
  );

  const result = await installWorkflowBundle({
    bytes: bundleBytes(m),
    source: SRC,
    root,
    level: 'project',
    lockPath,
    journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: fakeIngestor(),
    verifier: fakeVerifier(),
  });

  assert.equal(result.installed, true);
  assert.deepEqual(result.workflows, ['other', 'widget']);
  assert.deepEqual(readWorkflowStoreIndex(storeIndexPath(root)), {
    version: 1,
    entries: {
      'acme/widget@1.0.0': {
	digest: m.digest,
	pinned: false,
	workflows: ['other', 'widget'],
      },
    },
  });
});

// ---- tamper, verifier, and validation refusals -------------------------------------

test('install: state directory and lock/journal leaves are guarded before lock acquisition', async () => {
  const cases: Array<{
    name: string;
    setup: (root: string, lockPath: string, journalPath: string) => void;
    expected: RegExp;
  }> = [
    {
      name: 'state directory symlink',
      setup: (root) => symlinkSync(mkdtempSync(join(tmpdir(), 'owenloop-state-target-')), join(root, '.owenloop')),
      expected: /install state directory .*symlink/,
    },
    {
      name: 'lock leaf symlink',
      setup: (_root, lockPath) => symlinkSync(mkdtempSync(join(tmpdir(), 'owenloop-lock-target-')), lockPath),
      expected: /install lock .*symlink/,
    },
    {
      name: 'journal leaf symlink',
      setup: (_root, _lockPath, journalPath) => symlinkSync(mkdtempSync(join(tmpdir(), 'owenloop-journal-target-')), journalPath),
      expected: /crash-recovery journal .*symlink/,
    },
    {
      name: 'lock leaf directory',
      setup: (_root, lockPath) => mkdirSync(lockPath),
      expected: /install lock .*not a regular file/,
    },
    {
      name: 'journal leaf directory',
      setup: (_root, _lockPath, journalPath) => mkdirSync(journalPath),
      expected: /crash-recovery journal .*not a regular file/,
    },
  ];

  for (const { name, setup, expected } of cases) {
    const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore(`owenloop-state-guard-${name.replaceAll(' ', '-')}-`);
    if (name !== 'state directory symlink') mkdirSync(join(root, '.owenloop'), { recursive: true });
    setup(root, lockPath, journalPath);
    const ingestor = fakeIngestor();
    await assert.rejects(
      installWorkflowBundle({
	bytes: bundleBytes(makeBundle(name.replaceAll(' ', '-'))),
	source: SRC,
	root,
	level: 'project',
	lockPath,
	journalPath,
	recoveryMarkerDir: installMarkerDir,
	ingestor,
	verifier: fakeVerifier(),
      }),
      expected,
      name,
    );
    assert.equal(ingestor.ingests, 0, `${name}: A1 did not run before the refusal`);
  }
});

test('install: a symlinked object parent is corrupt and never used as a destination', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  symlinkSync(mkdtempSync(join(tmpdir(), 'owenloop-object-target-')), join(root, 'objects'));
  const m = makeBundle('object-parent-link');

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m),
      source: SRC,
      root,
      level: 'project',
      lockPath,
      journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(),
      verifier: fakeVerifier(),
    }),
    (e: unknown) => e instanceof StoreIntegrityError && e.code === 'object-corrupt' && /symlink/.test(e.message),
  );
  assert.ok(!existsSync(storeIndexPath(root)), 'index was not written');
});

test('install: one altered byte is rejected by A1 before anything is committed', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();
  const bytes = bundleBytes(m);
  // Flip one content byte inside the staged-file payload (the JSON stays
  // parseable, so the refusal is the DIGEST gate, not a parse error). The
  // bundle is ASCII-only, so a char index in the decoded text IS a byte index.
  const idx = new TextDecoder().decode(bytes).indexOf('name: widget');
  assert.ok(idx >= 0, 'fixture sanity: staged file content present in the bundle');
  bytes[idx] = 0x78; // 'x'

  await assert.rejects(
    installWorkflowBundle({
      bytes,
      source: SRC,
      root,
      level: 'project',
      lockPath,
      journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(),
      verifier: fakeVerifier(),
    }),
    /digest mismatch/,
  );

  assert.ok(!existsSync(storeIndexPath(root)), 'no index written');
  assert.ok(!existsSync(join(root, 'objects')), 'no object written');
  assert.ok(!existsSync(journalPath), 'no journal left');
  await assertLockReleased(lockPath, 'lock released after digest refusal');
  assert.ok(!existsSync(join(root, '.owenloop-staging')), 'staging debris cleared');
});

test('install: an A2 verifier rejection commits nothing', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();
  const verifier = fakeVerifier({ fail: true });

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m),
      source: SRC,
      root,
      level: 'project',
      lockPath,
      journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(),
      verifier,
    }),
    /pre-commit verification refused/,
  );

  assert.equal(verifier.calls.length, 1, 'verifier was called with the staged object');
  assert.ok(!existsSync(storeIndexPath(root)), 'no index written');
  assert.ok(!existsSync(join(root, 'objects')), 'no object written');
  assert.ok(!existsSync(journalPath), 'no journal left');
});

test('install: staged content that fails ENGINE validation is refused before A2 runs', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  // A file that is not even parseable YAML fails the loadDefsRaw pass.
  const m = makeBundle('broken', { 'def.yaml': 'name: broken\n\tsteps: not yaml (tab indent)\n' });
  const verifier = fakeVerifier();

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m),
      source: SRC,
      root,
      level: 'project',
      lockPath,
      journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(),
      verifier,
    }),
    /refusing to install bundle .* problem\(s\) found/,
  );

  assert.equal(verifier.calls.length, 0, 'A2 must NOT run when engine validation fails');
  assert.ok(!existsSync(storeIndexPath(root)), 'no index written');
  assert.ok(!existsSync(join(root, 'objects')), 'no object written');
});

// ---- dedupe and conflict -----------------------------------------------------------

test('install: the SAME bundle twice dedupes — the second is an index-only no-op', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();
  const ingestor = fakeIngestor();

  const first = await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor, verifier: fakeVerifier(),
  });
  const indexBefore = readFileSync(storeIndexPath(root), 'utf8');

  const second = await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor, verifier: fakeVerifier(),
  });

  assert.equal(first.installed, true);
  assert.equal(second.installed, false, 'second install dedupes');
  assert.equal(second.objectPath, first.objectPath);
  assert.equal(ingestor.verifies.length, 1, 'the existing object was verified before dedupe');
  assert.equal(readFileSync(storeIndexPath(root), 'utf8'), indexBefore, 'index unchanged by dedupe');
  assert.ok(!existsSync(journalPath));
});

test('install: a corrupt same-digest object is repaired from validated staged bytes, then dedupes', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();
  await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: fakeIngestor(), verifier: fakeVerifier(),
  });
  const objDir = join(root, objectDestRelPath(defDigest(m.digest)));
  chmodSync(objDir, 0o755);
  chmodSync(join(objDir, 'def.yaml'), 0o644);
  writeFileSync(join(objDir, 'def.yaml'), 'tampered');
  const indexBefore = readFileSync(storeIndexPath(root), 'utf8');
  const repairing = fakeIngestor({ failVerify: (_input, call) => call === 1 });

  const repaired = await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: repairing, verifier: fakeVerifier(),
  });

  assert.equal(repaired.installed, false, 'repair reuses the existing digest identity');
  assert.equal(readFileSync(join(objDir, 'def.yaml'), 'utf8'), validDefYaml('widget'));
  assert.equal(statSync(join(objDir, 'def.yaml')).mode & 0o7777, 0o444);
  assert.equal(readFileSync(storeIndexPath(root), 'utf8'), indexBefore, 'same-digest index bytes stay unchanged');
  assert.deepEqual(repairing.verifies.map((call) => call.objectDir), [objDir, repairing.verifies[1]!.objectDir, objDir]);
  assert.notEqual(repairing.verifies[1]!.objectDir, objDir, 'the staged repair is verified independently');

  const deduped = await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: repairing, verifier: fakeVerifier(),
  });
  assert.equal(deduped.installed, false);
  assert.equal(repairing.verifies.length, 4, 'second reinstall verifies once and takes normal dedupe');
  assert.ok(!existsSync(journalPath));
});

test('install: a staged repair verification failure leaves the prior broken object and index untouched', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();
  await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: fakeIngestor(), verifier: fakeVerifier(),
  });
  const objDir = join(root, objectDestRelPath(defDigest(m.digest)));
  chmodSync(objDir, 0o755);
  chmodSync(join(objDir, 'def.yaml'), 0o644);
  writeFileSync(join(objDir, 'def.yaml'), 'prior broken object');
  const indexBefore = readFileSync(storeIndexPath(root), 'utf8');
  const failing = fakeIngestor({ failVerify: (_input, call) => call === 1 || call === 2 });

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: failing, verifier: fakeVerifier(),
    }),
    (error: unknown) => error instanceof StoreIntegrityError &&
      error.code === 'object-corrupt' &&
      /supplied archive could not produce a verified repair object/.test(error.message),
  );

  assert.equal(readFileSync(join(objDir, 'def.yaml'), 'utf8'), 'prior broken object');
  assert.equal(readFileSync(storeIndexPath(root), 'utf8'), indexBefore);
  assert.ok(!existsSync(journalPath));
  assert.ok(!existsSync(join(root, '.owenloop-staging')));
});

test('install: failed replacement verification restores the prior broken object, index, and exact modes', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle('widget', {
    'def.yaml': validDefYaml('widget'),
    'nested/note.txt': 'nested prior content\n',
  });
  await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: fakeIngestor(), verifier: fakeVerifier(),
  });
  const objDir = join(root, objectDestRelPath(defDigest(m.digest)));
  chmodSync(join(objDir, 'def.yaml'), 0o644);
  writeFileSync(join(objDir, 'def.yaml'), 'prior broken object');
  chmodSync(join(objDir, 'def.yaml'), 0o444);
  assert.equal(statSync(objDir).mode & 0o7777, 0o555);
  assert.equal(statSync(join(objDir, 'nested')).mode & 0o7777, 0o555);
  const indexBefore = readFileSync(storeIndexPath(root), 'utf8');
  const failing = fakeIngestor({ failVerify: (_input, call) => call === 1 || call === 3 });

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: failing, verifier: fakeVerifier(),
    }),
    /replacement verification or hardening failed .*install rolled back, previous state restored/,
  );

  assert.equal(readFileSync(join(objDir, 'def.yaml'), 'utf8'), 'prior broken object');
  assert.equal(readFileSync(storeIndexPath(root), 'utf8'), indexBefore);
  assert.equal(statSync(objDir).mode & 0o7777, 0o555, 'rollback restores exact object-root mode');
  assert.equal(statSync(join(objDir, 'nested')).mode & 0o7777, 0o555, 'rollback preserves nested hardened mode');
  assert.equal(statSync(join(objDir, 'def.yaml')).mode & 0o7777, 0o444, 'rollback preserves hardened file mode');
  assert.ok(!existsSync(journalPath));
  assert.ok(!existsSync(join(root, '.owenloop-staging')));
});

test('install: an existing coordinate at a DIFFERENT digest is a conflict — no implicit retarget', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m1 = makeBundle('widget');
  await installWorkflowBundle({
    bytes: bundleBytes(m1), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: fakeIngestor(), verifier: fakeVerifier(),
  });
  // Same coordinate, different content ⇒ different digest.
  const m2 = makeBundle('widget', { 'def.yaml': validDefYaml('widget') + '# v2 content\n' });
  assert.notEqual(m2.digest, m1.digest);

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m2), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(), verifier: fakeVerifier(),
    }),
    /already recorded at digest/,
  );

  const idx = readWorkflowStoreIndex(storeIndexPath(root));
  assert.equal(idx.entries['acme/widget@1.0.0']?.digest, m1.digest, 'the original digest is retained');
  assert.ok(!existsSync(join(root, objectDestRelPath(defDigest(m2.digest)))), 'the new object was not committed');
});

// ---- index-write failure rolls the swap back ---------------------------------------

test('install: an index-write failure rolls the object back and restores the previous state', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();
  const indexPath = storeIndexPath(root);
  // Force the index WRITE to fail deterministically: squat a directory at the
  // index path from inside the verifier (after the in-lock read, before the
  // write). rename-atomic then fails (EISDIR), and the install must roll back.
  const verifier = fakeVerifier({
    onVerify: () => mkdirSync(indexPath, { recursive: true }),
  });

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(), verifier,
    }),
    /could not record install of .* — install rolled back, previous state restored/,
  );

  assert.ok(!existsSync(join(root, objectDestRelPath(defDigest(m.digest)))), 'the swapped-in object was rolled back');
  assert.ok(statSync(indexPath).isDirectory(), 'the squatting dir survives (previous state restored)');
  assert.ok(!existsSync(journalPath), 'journal dropped');
  await assertLockReleased(lockPath, 'lock released after rollback');
});

// ---- concurrent installs serialize on one root --------------------------------------

test('install: a repair index-write failure restores the exact prior object and clears rollback state', async () => {
  const fixture = await realRepairFixture('repair-index-write-failure');
  const indexPath = storeIndexPath(fixture.root);
  chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);
  const priorInode = statSync(fixture.objectDir).ino;
  const verifier = fakeVerifier({
    onVerify: () => {
      rmRecursiveForce(indexPath);
      mkdirSync(indexPath);
    },
  });

  await assert.rejects(
    installWorkflowBundle({
      bytes: fixture.packed.bytes,
      source: fixture.source,
      root: fixture.root,
      level: 'project',
      lockPath: fixture.lockPath,
      journalPath: fixture.journalPath,
      recoveryMarkerDir: fixture.markerDir,
      ingestor: createBundleIngestor(),
      verifier,
    }),
    /could not record install of .* — install rolled back, previous state restored/,
  );

  assert.equal(statSync(fixture.objectDir).ino, priorInode, 'rollback restores the exact prior directory inode');
  assert.equal(statSync(fixture.objectDir).mode & 0o7777, 0o555, 'rollback preserves the prior object-root mode');
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nestedDirRel)).mode & 0o7777,
    0o555,
    'rollback preserves the prior nested-directory mode',
  );
  assert.equal(
    statSync(join(fixture.objectDir, fixture.executableRel)).mode & 0o7777,
    0o555,
    'rollback preserves the prior executable-file mode',
  );
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nonExecutableRel)).mode & 0o7777,
    0o644,
    'rollback preserves the legacy prior non-executable-file mode',
  );
  assert.ok(!existsSync(fixture.journalPath), 'completed rollback removes the journal');
  assert.ok(!existsSync(join(fixture.root, '.owenloop-staging')), 'completed rollback removes staging debris');
  assert.deepEqual(readdirSync(fixture.markerDir), [], 'completed rollback removes the external marker');
});

test('install: two concurrent installs into one root both land (no lost index update)', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const mA = makeBundle('alpha');
  const mB = makeBundle('beta');

  const [rA, rB] = await Promise.all([
    installWorkflowBundle({
      bytes: bundleBytes(mA), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(), verifier: fakeVerifier(),
    }),
    installWorkflowBundle({
      bytes: bundleBytes(mB), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(), verifier: fakeVerifier(),
    }),
  ]);

  assert.equal(rA.installed, true);
  assert.equal(rB.installed, true);
  const idx = readWorkflowStoreIndex(storeIndexPath(root));
  assert.equal(idx.entries['acme/alpha@1.0.0']?.digest, mA.digest, 'first install recorded');
  assert.equal(idx.entries['acme/beta@1.0.0']?.digest, mB.digest, 'second install recorded — no lost update');
});

test('readers: every digest-backed path waits across the destination-to-backup rename gap', { timeout: 20_000 }, async () => {
  const fixture = await realRepairFixture('reader-gap');
  const requestedDigest = defInstructionDigest(loadDefFile(join(fixture.objectDir, 'workflow.yaml')));
  const stagingId = 'stg_reader_gap';
  const stagingDir = stageRealReplacement(fixture, stagingId);
  const globalRoot = tempDir('owenloop-reader-global-');
  const controlDir = tempDir('owenloop-reader-control-');
  const roles = ['resolve', 'instruction-uncached', 'instruction-cached', 'definitions', 'verify'] as const;
  const sleepWord = new Int32Array(new SharedArrayBuffer(4));
  const waitForPaths = (paths: string[], label: string, timeoutMs = 5_000): void => {
    const deadline = Date.now() + timeoutMs;
    while (!paths.every((path) => existsSync(path))) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      Atomics.wait(sleepWord, 0, 0, 10);
    }
  };

  const storeModule = new URL('../src/store/index.ts', import.meta.url).href;
  const childScript = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    import {
      createBundleIngestor,
      createStoreInstructionSource,
      loadCasDefs,
      resolveWorkflowDigest,
      verifyWorkflowObjectSync,
    } from ${JSON.stringify(storeModule)};

    const role = process.env.READER_ROLE;
    const root = process.env.READER_ROOT;
    const globalRoot = process.env.READER_GLOBAL_ROOT;
    const digest = process.env.READER_DIGEST;
    const requestedDigest = process.env.READER_INSTRUCTION_DIGEST;
    const objectDir = process.env.READER_OBJECT_DIR;
    const controlDir = process.env.READER_CONTROL_DIR;
    if (!role || !root || !globalRoot || !digest || !requestedDigest || !objectDir || !controlDir) {
      throw new Error('reader child is missing required environment');
    }
    const waitForFile = async (path) => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(path)) {
	if (Date.now() >= deadline) throw new Error('timed out waiting for ' + path);
	await delay(5);
      }
    };
    const resultPath = join(controlDir, 'result-' + role + '.json');
    try {
      const verifier = createBundleIngestor();
      const instructionSource = role === 'instruction-cached'
	? createStoreInstructionSource({ projectRoot: root, globalRoot, verifier })
	: undefined;
      if (instructionSource !== undefined) {
	const initial = await instructionSource.prime(requestedDigest);
	if (initial !== 'resolved') throw new Error('cached reader could not prime before repair');
	writeFileSync(join(controlDir, 'cached-ready'), 'ready');
      }
      await waitForFile(join(controlDir, 'gap-open'));
      writeFileSync(join(controlDir, 'started-' + role), 'started');

      let detail;
      if (role === 'resolve') {
	const resolved = await resolveWorkflowDigest({ digest, projectRoot: root, globalRoot, verifier });
	detail = { level: resolved.level };
      } else if (role === 'instruction-uncached') {
	const source = createStoreInstructionSource({ projectRoot: root, globalRoot, verifier });
	detail = { status: await source.prime(requestedDigest) };
      } else if (role === 'instruction-cached') {
	const status = await instructionSource.prime(requestedDigest);
	detail = { status, retained: instructionSource.getVerifiedObject(requestedDigest) !== undefined };
      } else if (role === 'definitions') {
	const warnings = [];
	const defs = loadCasDefs({ projectRoot: root, globalRoot, warn: (line) => warnings.push(line) });
	detail = { count: defs.length, warnings };
      } else if (role === 'verify') {
	verifyWorkflowObjectSync(objectDir, digest);
	detail = { verified: true };
      } else {
	throw new Error('unknown reader role ' + role);
      }
      writeFileSync(resultPath, JSON.stringify({ ok: true, detail }));
    } catch (error) {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: error?.stack ?? String(error) }));
      process.exitCode = 1;
    }
  `;

  const children = roles.map((role) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
      env: {
	...process.env,
	READER_ROLE: role,
	READER_ROOT: fixture.root,
	READER_GLOBAL_ROOT: globalRoot,
	READER_DIGEST: fixture.digest,
	READER_INSTRUCTION_DIGEST: requestedDigest,
	READER_OBJECT_DIR: fixture.objectDir,
	READER_CONTROL_DIR: controlDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const done = new Promise<void>((resolveChild, rejectChild) => {
      child.once('error', rejectChild);
      child.once('exit', (code, signal) => {
	if (code === 0) resolveChild();
	else rejectChild(new Error(`${role} reader exited with code ${String(code)} signal ${String(signal)}: ${stderr}`));
      });
    });
    return { role, done };
  });

  waitForPaths([join(controlDir, 'cached-ready')], 'cached instruction reader to prime');
  const journalBase = {
    version: 2 as const,
    phase: 'applying' as const,
    operation: 'repair' as const,
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    hadDest: true,
    root: fixture.root,
    metadataHash: fixture.metadataHash,
  };
  writeAddJournal(fixture.journalPath, journalBase);
  let hookFailure: Error | undefined;
  const handle = commitInstall(fixture.root, objectDestRelPath(fixture.digest), stagingDir, {
    afterBackupRename: () => {
      writeFileSync(join(controlDir, 'gap-open'), 'open');
      try {
	waitForPaths(
	  roles.map((role) => join(controlDir, `started-${role}`)),
	  'all readers to enter the rename gap',
	);
	Atomics.wait(sleepWord, 0, 0, 100);
	const early = roles.filter((role) => existsSync(join(controlDir, `result-${role}.json`)));
	if (early.length > 0) {
	  hookFailure = new Error(`readers returned while the digest destination was absent: ${early.join(', ')}`);
	}
      } catch (error) {
	hookFailure = error as Error;
      }
    },
  });

  writeAddJournal(fixture.journalPath, { ...journalBase, phase: 'replacement-swapped' });
  hardenObjectModes(handle.dest);
  writeAddJournal(fixture.journalPath, { ...journalBase, phase: 'replacement-hardened' });
  verifyWorkflowObjectSync(handle.dest, fixture.digest, { coordinateRepair: false });
  writeAddJournal(fixture.journalPath, { ...journalBase, phase: 'replacement-verified' });
  writeAddJournal(fixture.journalPath, { ...journalBase, phase: 'finalizing' });
  finalizeInstallCommit(handle);
  removeAddJournal(fixture.journalPath);

  await Promise.all(children.map((child) => child.done));
  if (hookFailure !== undefined) throw hookFailure;
  for (const role of roles) {
    const result = JSON.parse(readFileSync(join(controlDir, `result-${role}.json`), 'utf8')) as {
      ok: boolean;
      detail?: { status?: string; retained?: boolean; count?: number; warnings?: string[]; verified?: boolean };
      error?: string;
    };
    assert.equal(result.ok, true, `${role}: ${result.error ?? 'reader failed'}`);
    if (role === 'instruction-uncached' || role === 'instruction-cached') {
      assert.equal(result.detail?.status, 'resolved', `${role} never returns unknown-digest`);
    }
    if (role === 'instruction-cached') {
      assert.equal(result.detail?.retained, true, 'transient repair gap does not evict the valid cache entry');
    }
    if (role === 'definitions') {
      assert.ok((result.detail?.count ?? 0) > 0, 'definition discovery does not skip the valid object');
      assert.deepEqual(result.detail?.warnings, [], 'definition discovery emits no repair-gap warning');
    }
    if (role === 'verify') assert.equal(result.detail?.verified, true);
  }
  assertHardenedRepairTree(fixture);
});

// ---- fail-closed adapters ------------------------------------------------------------

test('install: a missing A1 adapter fails closed before any commit', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: undefined as unknown as BundleIngestor, verifier: fakeVerifier(),
    }),
    BundleIngestorUnavailableError,
  );
  assert.ok(!existsSync(join(root, 'objects')), 'nothing committed');
  assert.ok(!existsSync(journalPath));
});

test('install: a missing A2 adapter fails closed before any commit', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: fakeIngestor(), verifier: undefined as unknown as PreCommitVerifier,
    }),
    PreCommitVerifierUnavailableError,
  );
  assert.ok(!existsSync(join(root, 'objects')), 'nothing committed');
  assert.ok(!existsSync(journalPath));
});

// ---- crash recovery at every phase (simulated on-disk states) ------------------------

test('recovery: crash BEFORE the swap — staged debris cleared, dest never created, journal dropped', async () => {
  const { root, lockPath, journalPath } = tempStore();
  const digest = defDigest('c'.repeat(64));
  const stagingRoot = join(root, '.owenloop-staging');
  const stagingId = 'stg_crash1';
  // The interrupted state: journal written (applying), staging present, no swap yet.
  mkdirSync(join(stagingRoot, stagingId), { recursive: true });
  writeFileSync(join(stagingRoot, stagingId, 'def.yaml'), validDefYaml('crashed'));
  writeAddJournal(journalPath, {
    version: 2, phase: 'applying',
    destSegments: ['objects', 'sha256', digest],
    stagingId, hadDest: false, root,
    metadataHash: sha256Hex(canonicalJsonBytes({ version: 1, entries: {} })),
  });

  const outcome = await recoverWorkflowStore({ root, lockPath, journalPath });

  assert.equal(outcome, 'rolled-back');
  assert.ok(!existsSync(join(root, objectDestRelPath(digest))), 'dest never created');
  assert.ok(!existsSync(stagingRoot), 'staging debris cleared');
  assert.ok(!existsSync(journalPath), 'journal dropped');
  // Second recovery is a no-op.
  assert.equal(await recoverWorkflowStore({ root, lockPath, journalPath }), 'no-journal');
});

test('recovery: same-digest repair crash before swap restores the prior object and permits reinstall', async () => {
  const fixture = await realRepairFixture('repair-before-swap');
  chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);
  const priorInode = statSync(fixture.objectDir).ino;
  const stagingId = 'stg_repair_before_swap';
  stageRealReplacement(fixture, stagingId);
  writeAddJournal(fixture.journalPath, {
    version: 2,
    phase: 'applying',
    operation: 'repair',
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    hadDest: true,
    root: fixture.root,
    metadataHash: fixture.metadataHash,
  });

  const outcome = await recoverWorkflowStore({
    root: fixture.root,
    lockPath: fixture.lockPath,
    journalPath: fixture.journalPath,
  });

  assert.equal(outcome, 'rolled-back');
  assert.equal(statSync(fixture.objectDir).ino, priorInode, 'recovery leaves the prior object in place');
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nonExecutableRel)).mode & 0o7777,
    0o644,
    'the prior mode is restored exactly',
  );
  assert.ok(!existsSync(join(fixture.root, '.owenloop-staging')));
  assert.ok(!existsSync(fixture.journalPath));
  await assertBrokenRecoveryReinstallsAndThenDedupes(fixture);
});

test('recovery: same-digest repair crash after backup rename restores exact modes and permits reinstall', async () => {
  const fixture = await realRepairFixture('repair-after-backup');
  chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);
  const priorInode = statSync(fixture.objectDir).ino;
  const stagingId = 'stg_repair_after_backup';
  const stagingDir = stageRealReplacement(fixture, stagingId);
  const backupDir = `${stagingDir}-old`;
  renameDirRestoringWrite(fixture.objectDir, backupDir);
  writeAddJournal(fixture.journalPath, {
    version: 2,
    phase: 'applying',
    operation: 'repair',
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    hadDest: true,
    root: fixture.root,
    metadataHash: fixture.metadataHash,
  });

  const outcome = await recoverWorkflowStore({
    root: fixture.root,
    lockPath: fixture.lockPath,
    journalPath: fixture.journalPath,
  });

  assert.equal(outcome, 'rolled-back');
  assert.equal(statSync(fixture.objectDir).ino, priorInode, 'recovery restores the retained prior directory');
  assert.equal(statSync(fixture.objectDir).mode & 0o7777, 0o555, 'recovery restores the exact prior root mode');
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nestedDirRel)).mode & 0o7777,
    0o555,
    'recovery preserves the nested directory mode',
  );
  assert.equal(
    statSync(join(fixture.objectDir, fixture.executableRel)).mode & 0o7777,
    0o555,
    'recovery preserves the executable file mode',
  );
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nonExecutableRel)).mode & 0o7777,
    0o644,
    'recovery restores the prior non-executable mode exactly',
  );
  assert.ok(!existsSync(join(fixture.root, '.owenloop-staging')));
  assert.ok(!existsSync(fixture.journalPath));
  await assertBrokenRecoveryReinstallsAndThenDedupes(fixture);
});

const repairCrashScenarios = [
  {
    // The destination rename completed, but the phase rewrite did not. Recovery
    // must use operation:'repair', not the unchanged index hash, to resume safely.
    name: 'immediately after replacement swap before its phase rewrite',
    phase: 'applying' as const,
    prepareReplacement: (_fixture: RealRepairFixture): void => {},
  },
  {
    name: 'during partial recursive hardening',
    phase: 'replacement-swapped' as const,
    prepareReplacement: (fixture: RealRepairFixture): void => {
      chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o444);
      chmodSync(join(fixture.objectDir, fixture.nestedDirRel), 0o555);
      // The root and executable remain writable. Recovery must rerun the full
      // recursive hardener instead of trusting the partially changed tree.
      assert.notEqual(statSync(fixture.objectDir).mode & 0o200, 0, 'object root remains writable mid-harden');
      assert.notEqual(
	statSync(join(fixture.objectDir, fixture.executableRel)).mode & 0o200,
	0,
	'executable remains writable mid-harden',
      );
    },
  },
  {
    name: 'after hardening before post-swap verification',
    phase: 'replacement-hardened' as const,
    prepareReplacement: (fixture: RealRepairFixture): void => hardenObjectModes(fixture.objectDir),
  },
  {
    name: 'after successful post-swap verification before final cleanup',
    phase: 'replacement-verified' as const,
    prepareReplacement: (fixture: RealRepairFixture): void => {
      hardenObjectModes(fixture.objectDir);
      verifyWorkflowObjectSync(fixture.objectDir, fixture.digest, { coordinateRepair: false });
    },
  },
];

for (const scenario of repairCrashScenarios) {
  test(`recovery: same-digest repair crash ${scenario.name} resumes safely and then dedupes`, async () => {
    const fixture = await realRepairFixture(`repair-${scenario.phase}`);
    // The retained prior object has the right canonical bytes but a writable
    // non-executable file, which is enough to require same-digest repair.
    chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);
    await assert.rejects(
      createBundleIngestor().verifyInstalledObject({
	objectDir: fixture.objectDir,
	digest: fixture.digest,
      }),
      /regular file mode is 0644, expected hardened store mode 0444/,
    );

    const stagingId = `stg_${scenario.phase.replaceAll('-', '_')}`;
    const stagingDir = stageRealReplacement(fixture, stagingId);
    const backupDir = `${stagingDir}-old`;
    renameDirRestoringWrite(fixture.objectDir, backupDir);
    renameSync(stagingDir, fixture.objectDir);
    scenario.prepareReplacement(fixture);
    writeAddJournal(fixture.journalPath, {
      version: 2,
      phase: scenario.phase,
      operation: 'repair',
      destSegments: ['objects', 'sha256', fixture.digest],
      stagingId,
      hadDest: true,
      root: fixture.root,
      metadataHash: fixture.metadataHash,
    });

    const outcome = await recoverWorkflowStore({
      root: fixture.root,
      lockPath: fixture.lockPath,
      journalPath: fixture.journalPath,
    });

    assert.equal(outcome, 'rolled-forward');
    assertHardenedRepairTree(fixture);
    assert.ok(!existsSync(backupDir), 'the retained prior object is deleted only after verification');
    assert.ok(!existsSync(join(fixture.root, '.owenloop-staging')));
    assert.ok(!existsSync(fixture.journalPath));
    await assertHealthyReinstallDedupesWithoutReplacement(fixture);
  });
}

const durableRollbackBoundaries = [
  {
    name: 'after rollback intent before the replacement move',
    phase: 'rollback-started' as const,
    prepare: (_input: DurableRepairRollbackFixture): void => {},
  },
  {
    name: 'after the replacement move before its phase write',
    phase: 'rollback-started' as const,
    prepare: parkRepairReplacement,
  },
  {
    name: 'after the replacement-parked phase write',
    phase: 'rollback-replacement-parked' as const,
    prepare: parkRepairReplacement,
  },
  {
    name: 'after prior restoration before its phase write',
    phase: 'rollback-replacement-parked' as const,
    prepare: (input: DurableRepairRollbackFixture): void => {
      parkRepairReplacement(input);
      restoreRepairPrior(input);
    },
  },
  {
    name: 'after the prior-restored phase write before undo cleanup',
    phase: 'rollback-prior-restored' as const,
    prepare: (input: DurableRepairRollbackFixture): void => {
      parkRepairReplacement(input);
      restoreRepairPrior(input);
    },
  },
  {
    name: 'after undo cleanup before the rollback-complete phase write',
    phase: 'rollback-prior-restored' as const,
    prepare: (input: DurableRepairRollbackFixture): void => {
      parkRepairReplacement(input);
      restoreRepairPrior(input);
      rmRecursiveForce(input.undoDir);
    },
  },
  {
    name: 'after the rollback-complete phase write before journal cleanup',
    phase: 'rollback-complete' as const,
    prepare: (input: DurableRepairRollbackFixture): void => {
      parkRepairReplacement(input);
      restoreRepairPrior(input);
      rmRecursiveForce(input.undoDir);
    },
  },
];

for (const boundary of durableRollbackBoundaries) {
  test(`recovery: durable repair rollback ${boundary.name} restores exact prior state`, async () => {
    const input = await durableRepairRollbackFixture(`rollback-boundary-${boundary.phase}-${boundary.name}`);
    boundary.prepare(input);
    writeAddJournal(input.fixture.journalPath, { ...input.journalBase, phase: boundary.phase });

    const outcome = await recoverWorkflowStore({
      root: input.fixture.root,
      lockPath: input.fixture.lockPath,
      journalPath: input.fixture.journalPath,
      recoveryMarkerDir: input.fixture.markerDir,
    });

    assert.equal(outcome, 'rolled-back');
    assertExactRestoredPrior(input);
    assertRollbackDebrisCleared(input);
    assert.equal(
      await recoverWorkflowStore({
	root: input.fixture.root,
	lockPath: input.fixture.lockPath,
	journalPath: input.fixture.journalPath,
	recoveryMarkerDir: input.fixture.markerDir,
      }),
      'no-journal',
      'repeated recovery changes nothing',
    );
    await assertBrokenRecoveryReinstallsAndThenDedupes(input.fixture);
  });
}

test('recovery: rollback intent write failure leaves both copies for safe repair roll-forward', async () => {
  const input = await durableRepairRollbackFixture('rollback-intent-write-failure');
  assert.throws(
    () => rollbackInstallCommit(input.handle, {
      beforeRollback: () => {
	throw new Error('injected rollback intent write failure');
      },
      cleanupUndo: true,
    }),
    /injected rollback intent write failure/,
  );
  assert.ok(existsSync(input.fixture.objectDir), 'replacement remains at destination');
  assert.ok(existsSync(input.backupDir), 'the only prior object remains retained');
  assert.ok(!existsSync(input.undoDir), 'rollback did not start without durable intent');

  const outcome = await recoverWorkflowStore({
    root: input.fixture.root,
    lockPath: input.fixture.lockPath,
    journalPath: input.fixture.journalPath,
    recoveryMarkerDir: input.fixture.markerDir,
  });

  assert.equal(outcome, 'rolled-forward');
  assertHardenedRepairTree(input.fixture);
  assertRollbackDebrisCleared(input);
  await assertHealthyReinstallDedupesWithoutReplacement(input.fixture);
});

const rollbackPhaseWriteFailures = [
  {
    name: 'replacement-parked phase write',
    rollback: (input: DurableRepairRollbackFixture): void => rollbackInstallCommit(input.handle, {
      beforeRollback: () => {
	writeAddJournal(input.fixture.journalPath, { ...input.journalBase, phase: 'rollback-started' });
      },
      afterDestinationParked: () => {
	throw new Error('injected replacement-parked phase write failure');
      },
      cleanupUndo: true,
    }),
  },
  {
    name: 'prior-restored phase write',
    rollback: (input: DurableRepairRollbackFixture): void => rollbackInstallCommit(input.handle, {
      beforeRollback: () => {
	writeAddJournal(input.fixture.journalPath, { ...input.journalBase, phase: 'rollback-started' });
      },
      afterDestinationParked: () => {
	writeAddJournal(input.fixture.journalPath, {
	  ...input.journalBase,
	  phase: 'rollback-replacement-parked',
	});
      },
      afterPriorRestored: () => {
	throw new Error('injected prior-restored phase write failure');
      },
      cleanupUndo: true,
    }),
  },
  {
    name: 'rollback-complete phase write',
    rollback: (input: DurableRepairRollbackFixture): void => rollbackInstallCommit(input.handle, {
      beforeRollback: () => {
	writeAddJournal(input.fixture.journalPath, { ...input.journalBase, phase: 'rollback-started' });
      },
      afterDestinationParked: () => {
	writeAddJournal(input.fixture.journalPath, {
	  ...input.journalBase,
	  phase: 'rollback-replacement-parked',
	});
      },
      afterPriorRestored: () => {
	writeAddJournal(input.fixture.journalPath, {
	  ...input.journalBase,
	  phase: 'rollback-prior-restored',
	});
      },
      cleanupUndo: true,
      afterUndoCleanup: () => {
	throw new Error('injected rollback-complete phase write failure');
      },
    }),
  },
];

for (const failure of rollbackPhaseWriteFailures) {
  test(`recovery: ${failure.name} failure resumes the durable rollback`, async () => {
    const input = await durableRepairRollbackFixture(`rollback-phase-failure-${failure.name}`);
    assert.throws(() => failure.rollback(input), /injected .* phase write failure/);

    const outcome = await recoverWorkflowStore({
      root: input.fixture.root,
      lockPath: input.fixture.lockPath,
      journalPath: input.fixture.journalPath,
      recoveryMarkerDir: input.fixture.markerDir,
    });

    assert.equal(outcome, 'rolled-back');
    assertExactRestoredPrior(input);
    assertRollbackDebrisCleared(input);
    await assertBrokenRecoveryReinstallsAndThenDedupes(input.fixture);
  });
}

test('recovery: stale legacy replacement phase after completed rollback is cleared without verifying the prior object', async () => {
  const fixture = await realRepairFixture('legacy-completed-repair-rollback');
  chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);
  const priorInode = statSync(fixture.objectDir).ino;
  const stagingId = 'stg_legacy_completed_repair_rollback';
  const stagingDir = stageRealReplacement(fixture, stagingId);
  const backupDir = `${stagingDir}-old`;
  const undoDir = `${stagingDir}-undo`;
  const handle = commitInstall(fixture.root, objectDestRelPath(fixture.digest), stagingDir);
  hardenObjectModes(handle.dest);
  rollbackInstallCommit(handle);
  assert.ok(existsSync(fixture.objectDir), 'legacy rollback restored the destination');
  assert.ok(!existsSync(stagingDir), 'legacy rollback consumed staging');
  assert.ok(!existsSync(backupDir), 'legacy rollback consumed the prior backup');
  assert.ok(existsSync(undoDir), 'legacy rollback parked the replacement under undo');
  writeAddJournal(fixture.journalPath, {
    version: 2,
    phase: 'replacement-swapped',
    operation: 'repair',
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    hadDest: true,
    root: fixture.root,
    metadataHash: fixture.metadataHash,
  });

  const outcome = await recoverWorkflowStore({
    root: fixture.root,
    lockPath: fixture.lockPath,
    journalPath: fixture.journalPath,
    recoveryMarkerDir: fixture.markerDir,
  });

  assert.equal(outcome, 'rolled-back');
  assert.equal(statSync(fixture.objectDir).ino, priorInode, 'legacy recovery preserves the exact prior directory');
  assert.equal(
    statSync(join(fixture.objectDir, fixture.nonExecutableRel)).mode & 0o7777,
    0o644,
    'legacy recovery does not require the prior mode-loss object to pass the new verifier',
  );
  assert.ok(!existsSync(backupDir));
  assert.ok(!existsSync(undoDir));
  assert.ok(!existsSync(fixture.journalPath));
  assert.ok(!existsSync(join(fixture.root, '.owenloop-staging')));
  await assertBrokenRecoveryReinstallsAndThenDedupes(fixture);
});

test('recovery: a stale legacy rollback with incomplete claimed identity evidence is refused', async () => {
  const fixture = await realRepairFixture('legacy-incomplete-repair-marker');
  chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);
  const priorInode = statSync(fixture.objectDir).ino;
  const stagingId = 'stg_legacy_incomplete_repair_marker';
  const stagingDir = stageRealReplacement(fixture, stagingId);
  const marker = createRecoveryMarker({
    root: fixture.root,
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    markerDir: fixture.markerDir,
    operation: 'repair',
    replacementDir: stagingDir,
  });
  const handle = commitInstall(fixture.root, objectDestRelPath(fixture.digest), stagingDir);
  hardenObjectModes(handle.dest);
  rollbackInstallCommit(handle);
  writeAddJournal(fixture.journalPath, {
    version: 2,
    phase: 'replacement-swapped',
    operation: 'repair',
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    hadDest: true,
    root: fixture.root,
    metadataHash: fixture.metadataHash,
    recoveryMarkerId: marker.id,
  });

  await assert.rejects(
    recoverWorkflowStore({
      root: fixture.root,
      lockPath: fixture.lockPath,
      journalPath: fixture.journalPath,
      recoveryMarkerDir: fixture.markerDir,
    }),
    /marker lacks complete replacement\/prior identity evidence/,
  );

  assert.equal(statSync(fixture.objectDir).ino, priorInode, 'the exact prior object remains at the destination');
  assert.ok(existsSync(handle.undoDir), 'the claimed replacement remains untouched');
  assert.ok(existsSync(fixture.journalPath), 'the contradictory journal remains as evidence');
  assert.ok(existsSync(marker.path), 'the incomplete marker remains as evidence');
});

test('readers: repair rollback waits while destination can move and unblocks after exact prior restoration', async () => {
  const input = await durableRepairRollbackFixture('reader-rollback-coordination');
  writeAddJournal(input.fixture.journalPath, { ...input.journalBase, phase: 'rollback-started' });
  let resolved = false;
  const waiting = waitForDigestRepair(input.fixture.root, input.fixture.digest, {
    timeoutMs: 2_000,
    retryMs: 5,
  }).then(() => { resolved = true; });

  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(resolved, false, 'reader remains blocked before the replacement moves');
  parkRepairReplacement(input);
  writeAddJournal(input.fixture.journalPath, {
    ...input.journalBase,
    phase: 'rollback-replacement-parked',
  });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(resolved, false, 'reader remains blocked while the digest destination is absent');

  restoreRepairPrior(input);
  writeAddJournal(input.fixture.journalPath, { ...input.journalBase, phase: 'rollback-prior-restored' });
  await waiting;
  assert.equal(resolved, true, 'reader unblocks when the exact prior directory is stable');
  assert.ok(existsSync(input.fixture.journalPath), 'stable rollback cleanup may still have an active journal');
  assert.ok(existsSync(input.undoDir), 'stable rollback cleanup may still have replacement debris');

  const outcome = await recoverWorkflowStore({
    root: input.fixture.root,
    lockPath: input.fixture.lockPath,
    journalPath: input.fixture.journalPath,
    recoveryMarkerDir: input.fixture.markerDir,
  });
  assert.equal(outcome, 'rolled-back');
  assertExactRestoredPrior(input);
  assertRollbackDebrisCleared(input);
});

test('recovery: rollback identity mismatch is refused without deleting unrelated paths', async () => {
  const input = await durableRepairRollbackFixture('rollback-identity-mismatch');
  parkRepairReplacement(input);
  const unrelated = join(input.fixture.root, '.owenloop-staging', 'unrelated-undo');
  renameDirRestoringWrite(input.undoDir, unrelated);
  mkdirSync(input.undoDir);
  writeFileSync(join(input.undoDir, 'keep.txt'), 'unrelated');
  writeAddJournal(input.fixture.journalPath, { ...input.journalBase, phase: 'rollback-started' });

  await assert.rejects(
    recoverWorkflowStore({
      root: input.fixture.root,
      lockPath: input.fixture.lockPath,
      journalPath: input.fixture.journalPath,
      recoveryMarkerDir: input.fixture.markerDir,
    }),
    /parked replacement .* does not belong to this transaction/,
  );

  assert.equal(readFileSync(join(input.undoDir, 'keep.txt'), 'utf8'), 'unrelated');
  assert.ok(existsSync(unrelated), 'the actual replacement is preserved outside the journal-derived undo path');
  assert.ok(existsSync(input.backupDir), 'the only prior object remains retained');
  assert.ok(existsSync(input.fixture.journalPath), 'contradictory journal remains as evidence');
});

test('recovery: malformed rollback identity evidence is refused before any mutation', async () => {
  const input = await durableRepairRollbackFixture('rollback-malformed-marker');
  writeAddJournal(input.fixture.journalPath, { ...input.journalBase, phase: 'rollback-started' });
  writeFileSync(input.marker.path, `${JSON.stringify({
    ...input.marker.record,
    replacementIdentity: { dev: input.marker.record.replacementIdentity?.dev, ino: 'not-decimal' },
  }, null, 2)}\n`);

  await assert.rejects(
    recoverWorkflowStore({
      root: input.fixture.root,
      lockPath: input.fixture.lockPath,
      journalPath: input.fixture.journalPath,
      recoveryMarkerDir: input.fixture.markerDir,
    }),
    /replacementIdentity\.ino.*not a decimal string/,
  );

  assert.ok(existsSync(input.fixture.objectDir), 'replacement remains at the destination');
  assert.ok(existsSync(input.backupDir), 'the only prior object remains retained');
  assert.ok(!existsSync(input.undoDir), 'recovery performs no rollback rename');
  assert.ok(existsSync(input.fixture.journalPath), 'journal remains as evidence');
});

test('recovery: symlinked object parents are refused before any recovery mutation', async () => {
  const { root, lockPath, journalPath } = tempStore();
  const digest = defDigest('a'.repeat(64));
  const outside = mkdtempSync(join(tmpdir(), 'owenloop-recovery-object-target-'));
  writeFileSync(join(outside, 'victim'), 'keep');
  mkdirSync(join(root, '.owenloop'), { recursive: true });
  writeAddJournal(journalPath, {
    version: 2, phase: 'applying',
    destSegments: ['objects', 'sha256', digest],
    stagingId: 'stg_linked_objects', hadDest: false, root,
    metadataHash: sha256Hex(canonicalJsonBytes({ version: 1, entries: {} })),
  });
  symlinkSync(outside, join(root, 'objects'));

  await assert.rejects(
    recoverWorkflowStore({ root, lockPath, journalPath }),
    /recovery.*objects.*symlink|objects.*symlink/i,
  );
  assert.ok(existsSync(journalPath), 'journal remains as evidence');
  assert.equal(readFileSync(join(outside, 'victim'), 'utf8'), 'keep', 'outside target was untouched');
});

test('recovery: a symlinked metadata file is refused before commit-point probing', async () => {
  const { root, lockPath, journalPath } = tempStore();
  const digest = defDigest('e'.repeat(64));
  const objDir = join(root, objectDestRelPath(digest));
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, 'def.yaml'), validDefYaml('metadata-link'));

  const metadata = { version: 1, entries: {} };
  const outside = mkdtempSync(join(tmpdir(), 'owenloop-recovery-metadata-target-'));
  const outsideIndex = join(outside, 'index.json');
  writeFileSync(outsideIndex, `${JSON.stringify(metadata, null, 2)}\n`);
  writeAddJournal(journalPath, {
    version: 2,
    phase: 'applying',
    destSegments: ['objects', 'sha256', digest],
    stagingId: 'stg_metadata_link',
    hadDest: false,
    root,
    metadataHash: sha256Hex(canonicalJsonBytes(metadata)),
  });
  symlinkSync(outsideIndex, storeIndexPath(root));

  await assert.rejects(
    recoverWorkflowStore({ root, lockPath, journalPath }),
    /install metadata.*symlink|metadata.*symlink/i,
  );
  assert.ok(existsSync(journalPath), 'journal remains as evidence');
  assert.ok(existsSync(objDir), 'destination remains untouched');
  assert.equal(readFileSync(outsideIndex, 'utf8'), `${JSON.stringify(metadata, null, 2)}\n`);
});

test('recovery: a fresh v2 swap is discarded only with a matching external marker', async () => {
  const { root, lockPath, journalPath } = tempStore();
  const markerDir = mkdtempSync(join(tmpdir(), 'owenloop-recovery-markers-'));
  const digest = defDigest('b'.repeat(64));
  const stagingId = 'stg_fresh_marker';
  const destSegments = ['objects', 'sha256', digest];
  const objDir = join(root, ...destSegments);
  // Crash window: the fresh staging directory was renamed to the final object,
  // but the metadata write never landed. No staging or backup remains.
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, 'def.yaml'), validDefYaml('orphaned'));
  const marker = createRecoveryMarker({ root, destSegments, stagingId, markerDir });
  writeAddJournal(journalPath, {
    version: 2, phase: 'applying',
    destSegments, stagingId, hadDest: false, root,
    metadataHash: sha256Hex(canonicalJsonBytes({ version: 1, entries: {} })),
    recoveryMarkerId: marker.id,
  });

  const outcome = await recoverWorkflowStore({ root, lockPath, journalPath, recoveryMarkerDir: markerDir });

  assert.equal(outcome, 'rolled-back');
  assert.ok(!existsSync(objDir), 'the corroborated fresh destination is discarded');
  assert.ok(!existsSync(join(root, '.owenloop-staging')), 'staging debris is cleared');
  assert.ok(!existsSync(journalPath), 'journal is removed last');
  assert.ok(!existsSync(marker.path), 'external marker is removed after journal cleanup');
});

test('recovery: crash BETWEEN the swap and the index write — the backup is restored over dest', async () => {
  const { root, lockPath, journalPath } = tempStore();
  const digest = defDigest('d'.repeat(64));
  const objDir = join(root, objectDestRelPath(digest));
  const stagingRoot = join(root, '.owenloop-staging');
  const stagingId = 'stg_crash2';
  const backupDir = join(stagingRoot, `${stagingId}-old`);
  // Same-content reinstall: dest held the previous copy (moved to backup),
  // the new content swapped in, then the index write never landed.
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, 'def.yaml'), 'NEW');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'def.yaml'), 'PREV');
  writeAddJournal(journalPath, {
    version: 2, phase: 'applying',
    destSegments: ['objects', 'sha256', digest],
    stagingId, hadDest: true, root,
    metadataHash: 'e'.repeat(64), // does not match the absent/empty index ⇒ commit point NOT reached
  });

  const outcome = await recoverWorkflowStore({ root, lockPath, journalPath });

  assert.equal(outcome, 'rolled-back');
  assert.equal(readFileSync(join(objDir, 'def.yaml'), 'utf8'), 'PREV', 'previous object restored');
  assert.ok(!existsSync(backupDir), 'backup consumed');
  assert.ok(!existsSync(journalPath));
  assert.equal(await recoverWorkflowStore({ root, lockPath, journalPath }), 'no-journal', 'second recovery is a no-op');
});

test('recovery: crash after the repair commit point re-verifies before deleting the backup', async () => {
  const fixture = await realRepairFixture('repair-finalizing');
  chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);
  const stagingId = 'stg_repair_finalizing';
  const stagingDir = stageRealReplacement(fixture, stagingId);
  const backupDir = `${stagingDir}-old`;
  renameDirRestoringWrite(fixture.objectDir, backupDir);
  renameSync(stagingDir, fixture.objectDir);
  hardenObjectModes(fixture.objectDir);
  verifyWorkflowObjectSync(fixture.objectDir, fixture.digest, { coordinateRepair: false });
  writeAddJournal(fixture.journalPath, {
    version: 2,
    phase: 'finalizing',
    operation: 'repair',
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    hadDest: true,
    root: fixture.root,
    metadataHash: fixture.metadataHash,
  });

  const outcome = await recoverWorkflowStore({
    root: fixture.root,
    lockPath: fixture.lockPath,
    journalPath: fixture.journalPath,
  });

  assert.equal(outcome, 'rolled-forward');
  assertHardenedRepairTree(fixture);
  assert.ok(!existsSync(backupDir), 'retained backup discarded after re-verification');
  assert.ok(!existsSync(join(fixture.root, '.owenloop-staging')));
  assert.ok(!existsSync(fixture.journalPath));
  assert.equal(
    await recoverWorkflowStore({ root: fixture.root, lockPath: fixture.lockPath, journalPath: fixture.journalPath }),
    'no-journal',
  );
  await assertHealthyReinstallDedupesWithoutReplacement(fixture);
});

test('recovery: a durable verified phase never accepts a replacement made writable afterward', async () => {
  const fixture = await realRepairFixture('repair-verified-tamper');
  const stagingId = 'stg_repair_verified_tamper';
  const stagingDir = stageRealReplacement(fixture, stagingId);
  const backupDir = `${stagingDir}-old`;
  renameDirRestoringWrite(fixture.objectDir, backupDir);
  renameSync(stagingDir, fixture.objectDir);
  hardenObjectModes(fixture.objectDir);
  verifyWorkflowObjectSync(fixture.objectDir, fixture.digest, { coordinateRepair: false });
  writeAddJournal(fixture.journalPath, {
    version: 2,
    phase: 'replacement-verified',
    operation: 'repair',
    destSegments: ['objects', 'sha256', fixture.digest],
    stagingId,
    hadDest: true,
    root: fixture.root,
    metadataHash: fixture.metadataHash,
  });
  chmodSync(join(fixture.objectDir, fixture.nonExecutableRel), 0o644);

  await assert.rejects(
    recoverWorkflowStore({ root: fixture.root, lockPath: fixture.lockPath, journalPath: fixture.journalPath }),
    /failed canonical or hardened-mode verification.*regular file mode is 0644/s,
  );

  assert.ok(existsSync(backupDir), 'the prior object remains retained');
  assert.ok(existsSync(fixture.journalPath), 'the journal remains for explicit recovery');
  assert.equal(statSync(join(fixture.objectDir, fixture.nonExecutableRel)).mode & 0o7777, 0o644);
});

test('recovery: a v1 journal at a project path is refused without a ledger (fail-closed)', async () => {
  const { root, lockPath, journalPath } = tempStore();
  // A legacy GitHub-route journal where the global-style recovery looks.
  writeAddJournal(journalPath, {
    version: 1, phase: 'applying',
    source: 'acme/widgets', sha: 'a'.repeat(40), folder: 'acme-widgets-aaaa',
    stagingId: 'stg_test', hadDest: false, defsDir: root, ref: 'HEAD', startedAt: 1,
  });

  await assert.rejects(
    recoverWorkflowStore({ root, lockPath, journalPath }),
    /requires the GitHub recovery entry point/,
  );
  assert.ok(existsSync(journalPath), 'journal left as evidence');
});

// ---- project installs share the project add lock/recovery ordering ------------------

test('install: a project install with a readLedger recovers a leftover v1 journal, then installs', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const stagingRoot = join(root, '.owenloop-staging');
  const stagingId = 'stg_v1left';
  // A v1 `finalizing` journal + backup debris (a GitHub install that crashed
  // at finalize). With a readLedger supplied, the project bundle install
  // recovers it inline before installing.
  mkdirSync(join(stagingRoot, stagingId, 'x'), { recursive: true }); // fake backup debris under staging
  writeAddJournal(journalPath, {
    version: 1, phase: 'finalizing',
    source: 'acme/widgets', sha: 'a'.repeat(40), folder: 'acme-widgets-aaaa',
    stagingId, hadDest: true, defsDir: root, ref: 'HEAD', startedAt: 1,
  });
  const m = makeBundle();

  const result = await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: fakeIngestor(), verifier: fakeVerifier(),
    readLedger: () => () => undefined,
  });

  assert.equal(result.installed, true);
  assert.ok(!existsSync(journalPath), 'v1 journal recovered then removed');
  assert.ok(!existsSync(stagingRoot), 'staging debris cleared');
  assert.equal(readWorkflowStoreIndex(storeIndexPath(root)).entries['acme/widget@1.0.0']?.digest, m.digest);
});

// ---- global installs keep equivalent state below the global root -----------------------

test('install: a global-root install keeps lock/journal/staging below the global root', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore('owenloop-wstore-global-');
  const m = makeBundle('globalwf');

  const result = await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'global', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: fakeIngestor(), verifier: fakeVerifier(),
  });

  assert.equal(result.level, 'global');
  assert.ok(result.objectPath.startsWith(join(root, 'objects')), 'object below the global root');
  await assertLockReleased(lockPath, 'global lock released');
  // A subsequent GLOBAL recovery on the same root is a clean no-op.
  assert.equal(await recoverWorkflowStore({ root, lockPath, journalPath }), 'no-journal');
});
