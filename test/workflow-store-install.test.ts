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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BundleIngestorUnavailableError,
  defDigest,
  installWorkflowBundle,
  objectDestRelPath,
  PreCommitVerifierUnavailableError,
  readWorkflowStoreIndex,
  StoreIntegrityError,
  recoverWorkflowStore,
  storeIndexPath,
  workflowCoordinate,
} from '../src/store/index.ts';
import type {
  BundleIngestor,
  BundleSource,
  DefDigest,
  PreCommitVerifier,
  WorkflowCoordinate,
} from '../src/store/index.ts';
import { ADD_JOURNAL_FILENAME, writeAddJournal } from '../src/add.ts';
import { canonicalJsonBytes, createRecoveryMarker, sha256Hex } from '../src/install.ts';

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
  /** Test convenience: equals `claim` for an untampered manifest; never serialized. */
  digest: string;
}

/** Content-digest primitive (test-owned; mirrors what A1 computes canonically). */
function sha256Content(coordinate: WireManifest['coordinate'], files: Record<string, string>): string {
  return createHash('sha256')
    .update(new TextEncoder().encode(JSON.stringify({ coordinate, files })))
    .digest('hex');
}

function makeBundle(name = 'widget', files?: Record<string, string>): WireManifest {
  const coordinate = { namespace: 'acme', name, version: '1.0.0' };
  const f = files ?? { 'def.yaml': validDefYaml(name) };
  const digest = sha256Content(coordinate, f);
  return { coordinate, files: f, claim: digest, digest };
}

/** Serialize the wire form: content + claim. Key order is stable (insertion order). */
function bundleBytes(m: WireManifest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ coordinate: m.coordinate, files: m.files, claim: m.claim }),
  );
}

/**
 * The fake A1 ingestor: parses the JSON fixture, checks the byte digest
 * against the manifest's claimed digest (the tamper gate), then unpacks the
 * files into the supplied stagingDir — returning ONLY after both checks pass,
 * mirroring the real adapter's contract. `verifyInstalledObject` records
 * calls and honours `failObjectDirs` (a set of object dirs to report corrupt).
 */
function fakeIngestor(opts: { failVerifyFor?: Set<string> } = {}): BundleIngestor & {
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
    }): Promise<{ coordinate: WorkflowCoordinate; digest: DefDigest }> {
      state.ingests++;
      (this as { ingests: number }).ingests = state.ingests;
      let m: { coordinate: WireManifest['coordinate']; files: Record<string, string>; claim: string };
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
      return { coordinate, digest: defDigest(m.claim) };
    },
    async verifyInstalledObject(input: { objectDir: string; digest: DefDigest }): Promise<void> {
      state.verifies.push(input);
      if (opts.failVerifyFor?.has(input.objectDir)) {
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

const SRC: BundleSource = { kind: 'file', path: '/nonexistent/origin.wnlp' }; // origin data only — never opened by the installer

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
  assert.equal(result.objectPath, join(root, objectDestRelPath(defDigest(m.digest))));

  // Object content + HARDENED modes (files 0o444, dirs 0o555, object dir included).
  const objDir = result.objectPath;
  const fileMode = statSync(join(objDir, 'def.yaml')).mode & 0o777;
  const dirMode = statSync(objDir).mode & 0o777;
  assert.equal(fileMode, 0o444, 'object files hardened read-only');
  assert.equal(dirMode, 0o555, 'object dir hardened non-writable');
  assert.equal(readFileSync(join(objDir, 'def.yaml'), 'utf8'), validDefYaml('widget'));

  // Index records the coordinate; journal and lock are gone; staging cleared.
  assert.deepEqual(readWorkflowStoreIndex(storeIndexPath(root)), {
    version: 1,
    entries: { 'acme/widget@1.0.0': { digest: m.digest, pinned: false } },
  });
  assert.ok(!existsSync(journalPath), 'journal removed on success');
  assert.ok(!existsSync(lockPath), 'lock released on success');
  assert.ok(!existsSync(join(root, '.owenloop-staging')), 'staging root cleared');
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
  assert.ok(!existsSync(lockPath), 'lock released');
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

test('install: dedupe against a CORRUPT existing object is a hard refusal (never replaced, never fallen through)', async () => {
  const { root, lockPath, journalPath, markerDir: installMarkerDir } = tempStore();
  const m = makeBundle();
  await installWorkflowBundle({
    bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
    recoveryMarkerDir: installMarkerDir,
    ingestor: fakeIngestor(), verifier: fakeVerifier(),
  });
  // Corrupt the installed object, then make A1 report it.
  const objDir = join(root, objectDestRelPath(defDigest(m.digest)));
  chmodSync(objDir, 0o755); // undo hardening so the corrupter can write
  chmodSync(join(objDir, 'def.yaml'), 0o644);
  writeFileSync(join(objDir, 'def.yaml'), 'tampered');
  const indexBefore = readFileSync(storeIndexPath(root), 'utf8');
  const failing = fakeIngestor({ failVerifyFor: new Set([objDir]) });

  await assert.rejects(
    installWorkflowBundle({
      bytes: bundleBytes(m), source: SRC, root, level: 'project', lockPath, journalPath,
      recoveryMarkerDir: installMarkerDir,
      ingestor: failing, verifier: fakeVerifier(),
    }),
    /existing object failed verification before dedupe/,
  );

  assert.equal(readFileSync(storeIndexPath(root), 'utf8'), indexBefore, 'index untouched');
  assert.equal(readFileSync(join(objDir, 'def.yaml'), 'utf8'), 'tampered', 'corrupt object left in place (never silently replaced)');
  assert.ok(!existsSync(journalPath), 'the pre-dedupe journal was dropped');
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
  assert.ok(!existsSync(lockPath), 'lock released');
});

// ---- concurrent installs serialize on one root --------------------------------------

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

test('recovery: crash AFTER the index write (finalizing) — rolls forward, keeps the object, drops the backup', async () => {
  const { root, lockPath, journalPath } = tempStore();
  const digest = defDigest('f'.repeat(64));
  const objDir = join(root, objectDestRelPath(digest));
  const stagingRoot = join(root, '.owenloop-staging');
  const stagingId = 'stg_crash3';
  const backupDir = join(stagingRoot, `${stagingId}-old`);
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, 'def.yaml'), validDefYaml('done'));
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'def.yaml'), 'OLD');
  writeAddJournal(journalPath, {
    version: 2, phase: 'finalizing',
    destSegments: ['objects', 'sha256', digest],
    stagingId, hadDest: true, root,
    metadataHash: sha256Hex(canonicalJsonBytes({ version: 1, entries: {} })),
  });

  const outcome = await recoverWorkflowStore({ root, lockPath, journalPath });

  assert.equal(outcome, 'rolled-forward');
  assert.equal(readFileSync(join(objDir, 'def.yaml'), 'utf8'), validDefYaml('done'), 'installed object kept');
  assert.ok(!existsSync(backupDir), 'retained backup discarded');
  assert.ok(!existsSync(stagingRoot), 'staging cleared');
  assert.ok(!existsSync(journalPath));
  assert.equal(await recoverWorkflowStore({ root, lockPath, journalPath }), 'no-journal');
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
  assert.ok(!existsSync(lockPath), 'lock released');
  // A subsequent GLOBAL recovery on the same root is a clean no-op.
  assert.equal(await recoverWorkflowStore({ root, lockPath, journalPath }), 'no-journal');
});
