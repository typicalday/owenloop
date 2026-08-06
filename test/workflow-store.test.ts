/**
 * The content-addressed WORKFLOW store's value types, `index.json` surface,
 * two-level roots, and fail-closed resolution — everything EXCEPT the bundle
 * install transaction (that is `test/workflow-store-install.test.ts`).
 *
 * Distinct from `test/store.test.ts`, which covers `src/store.ts` — the SQLite
 * RUNTIME store. Same word, different system; the tests live in separate files
 * for the same reason the modules do.
 *
 * Hermetic: every test builds its own temp roots under tmpdir; `HOME` for
 * `globalStoreRoot` is always an injected fixture path — the ambient
 * `~/.owenloop` is never read or written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import {
  BundleIngestorUnavailableError,
  defDigest,
  DIGEST_RE,
  emptyWorkflowStoreIndex,
  globalStoreRoot,
  isDefDigest,
  objectDirForDigest,
  parseWorkflowCoordinate,
  parseWorkflowStoreIndex,
  PreCommitVerifierUnavailableError,
  probeObjectDir,
  probeStoreRoot,
  projectStoreRoot,
  readWorkflowStoreIndex,
  resolveWorkflowCoordinate,
  resolveWorkflowDigest,
  serializeWorkflowStoreIndex,
  storeIndexPath,
  StoreAmbiguityError,
  StoreConflictError,
  StoreCoordinateError,
  StoreDigestError,
  StoreIndexError,
  StoreIntegrityError,
  StoreNotFoundError,
  StorePathError,
  workflowCoordinate,
  WorkflowStoreError,
  writeWorkflowStoreIndex,
} from '../src/store/index.ts';
import type { BundleIngestor, DefDigest, WorkflowStoreIndex } from '../src/store/index.ts';

// ---- fixtures --------------------------------------------------------------------

function tempDir(prefix = 'owenloop-wstore-rs-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A digest fixture (any 64 lowercase hex chars — shape only, no real object needed). */
function digest(c: string): DefDigest {
  return defDigest(c.repeat(64));
}

function writeIndex(root: string, entries: WorkflowStoreIndex['entries']): void {
  writeWorkflowStoreIndex(storeIndexPath(root), { version: 1, entries });
}

function seedObject(root: string, d: DefDigest, files: Record<string, string> = { 'def.yaml': 'name: seeded\n' }): string {
  const dir = objectDirForDigest(root, d);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  return dir;
}

/** A BundleIngestor double for resolution: only `verifyInstalledObject` is exercised. */
function resolvingVerifier(opts: { failFor?: Set<string> } = {}): BundleIngestor & {
  calls: Array<{ objectDir: string; digest: DefDigest }>;
} {
  const calls: Array<{ objectDir: string; digest: DefDigest }> = [];
  return {
    calls,
    async ingest(): Promise<never> {
      throw new Error('ingest is not used by resolution');
    },
    async verifyInstalledObject(input: { objectDir: string; digest: DefDigest }): Promise<void> {
      calls.push(input);
      if (opts.failFor?.has(input.objectDir)) {
        throw new Error(`object at ${input.objectDir} failed verification`);
      }
    },
  };
}

// ---- roots -----------------------------------------------------------------------

test('roots: the project root IS the resolved defs dir', () => {
  const defsDir = tempDir();
  assert.equal(projectStoreRoot(defsDir), resolvePath(defsDir));
  // A relative defs dir resolves against cwd — the store never invents a root.
  assert.equal(projectStoreRoot('workflows'), resolvePath('workflows'));
});

test('roots: the global root is <home>/.owenloop/workflows with an injectable home', () => {
  const fakeHome = tempDir();
  assert.equal(globalStoreRoot(fakeHome), join(fakeHome, '.owenloop', 'workflows'));
});

test('roots: the index path is <root>/index.json', () => {
  const root = tempDir();
  assert.equal(storeIndexPath(root), join(root, 'index.json'));
});

test('probeStoreRoot: absent is NOT an error; symlink and non-dir squatting are', () => {
  const root = tempDir();
  assert.equal(probeStoreRoot(join(root, 'missing')), 'absent');
  const real = join(root, 'real');
  mkdirSync(real);
  assert.equal(probeStoreRoot(real), 'dir');

  const linked = join(root, 'linked');
  symlinkSync(real, linked);
  assert.throws(() => probeStoreRoot(linked), (e: unknown) =>
    e instanceof StorePathError && /it is a symlink/.test(e.message) && e.code === 'path-refused');

  const file = join(root, 'plain-file');
  writeFileSync(file, 'x');
  assert.throws(() => probeStoreRoot(file), (e: unknown) =>
    e instanceof StorePathError && /not a directory/.test(e.message));
});

test('probeObjectDir: symlinked objects and sha256 parents are corrupt, not absent', () => {
  const d = digest('5');
  const objectsRoot = tempDir();
  const objects = join(objectsRoot, 'objects');
  symlinkSync(tempDir(), objects);
  assert.throws(() => probeObjectDir(objectDirForDigest(objectsRoot, d), d, 'project'), (e: unknown) =>
    e instanceof StoreIntegrityError && e.code === 'object-corrupt' && /objects/.test(e.message));

  const shaRoot = tempDir();
  mkdirSync(join(shaRoot, 'objects'));
  symlinkSync(tempDir(), join(shaRoot, 'objects', 'sha256'));
  assert.throws(() => probeObjectDir(objectDirForDigest(shaRoot, d), d, 'global'), (e: unknown) =>
    e instanceof StoreIntegrityError && e.code === 'object-corrupt' && /sha256/.test(e.message));
});

// ---- index.json round-trip + hostile shapes --------------------------------------

test('index: write→read round-trip; missing file reads as an EMPTY index (not an error)', () => {
  const root = tempDir();
  assert.deepEqual(readWorkflowStoreIndex(storeIndexPath(root)), emptyWorkflowStoreIndex());

  const d = digest('a');
  writeIndex(root, { 'acme/widget@1.0.0': { digest: d, pinned: false } });
  assert.deepEqual(readWorkflowStoreIndex(storeIndexPath(root)), {
    version: 1,
    entries: { 'acme/widget@1.0.0': { digest: d, pinned: false } },
  });
});

test('index: canonical serialization is stable across rewrites (diff-stable + hash-stable)', () => {
  const root = tempDir();
  const idx: WorkflowStoreIndex = {
    version: 1,
    entries: { 'acme/widget@1.0.0': { digest: digest('b'), pinned: true } },
  };
  writeWorkflowStoreIndex(storeIndexPath(root), idx);
  const first = serializeWorkflowStoreIndex(readWorkflowStoreIndex(storeIndexPath(root)));
  writeWorkflowStoreIndex(storeIndexPath(root), idx);
  const second = serializeWorkflowStoreIndex(readWorkflowStoreIndex(storeIndexPath(root)));
  assert.equal(first, second);
  assert.ok(first.endsWith('\n'), 'canonical bytes end with a newline');
});

test('index: corrupt JSON is a hard named error (never silently reset)', () => {
  const root = tempDir();
  writeFileSync(storeIndexPath(root), '{not json');
  assert.throws(() => readWorkflowStoreIndex(storeIndexPath(root)), (e: unknown) =>
    e instanceof StoreIndexError && /corrupt workflow store index/.test(e.message));
});

test('index: hostile shapes fail closed; unknown additive keys are tolerated', () => {
  const path = join(tempDir(), 'index.json');
  const good = { digest: digest('c'), pinned: false };

  const rejects: Array<[string, unknown]> = [
    ['top-level not an object', [1, 2, 3]],
    ['wrong version', { version: 2, entries: {} }],
    ['entries not an object', { version: 1, entries: [] }],
    ['entry not an object', { version: 1, entries: { 'acme/w@1': 'digestless' } }],
    ['key not a coordinate', { version: 1, entries: { 'no-slash@1': good } }],
    ['uppercase digest (never normalized)', { version: 1, entries: { 'acme/w@1': { digest: 'A'.repeat(64), pinned: false } } }],
    ['short digest', { version: 1, entries: { 'acme/w@1': { digest: 'ab', pinned: false } } }],
    ['pinned not a boolean', { version: 1, entries: { 'acme/w@1': { digest: good.digest, pinned: 'yes' } } }],
    ['workflow names not an array', { version: 1, entries: { 'acme/w@1': { digest: good.digest, pinned: false, workflows: 'w' } } }],
    ['invalid workflow name', { version: 1, entries: { 'acme/w@1': { digest: good.digest, pinned: false, workflows: ['Bad'] } } }],
    ['duplicate workflow name', { version: 1, entries: { 'acme/w@1': { digest: good.digest, pinned: false, workflows: ['one', 'one'] } } }],
    ['unsorted workflow names', { version: 1, entries: { 'acme/w@1': { digest: good.digest, pinned: false, workflows: ['zeta', 'alpha'] } } }],
  ];
  for (const [name, parsed] of rejects) {
    assert.throws(() => parseWorkflowStoreIndex(parsed, path), (e: unknown) =>
      e instanceof StoreIndexError && e.code === 'index-invalid',
      `expected StoreIndexError for: ${name}`);
  }

  // Unknown additive keys (forward compatibility) survive validation.
  const tolerant = parseWorkflowStoreIndex(
    { version: 1, entries: { 'acme/w@1': { digest: good.digest, pinned: true, signature: { alg: 'future' } } }, formatNote: 'x' },
    path,
  );
  assert.equal(tolerant.entries['acme/w@1']?.pinned, true);
});

test('index: a symlink or directory squatting at the index path is refused', () => {
  const root = tempDir();
  const target = join(root, 'elsewhere.json');
  writeFileSync(target, JSON.stringify({ version: 1, entries: {} }));
  symlinkSync(target, storeIndexPath(root));
  assert.throws(() => readWorkflowStoreIndex(storeIndexPath(root)), (e: unknown) =>
    e instanceof StoreIndexError && /it is a symlink/.test(e.message));
});

test('index: a directory at the index path is refused', () => {
  const root = tempDir();
  mkdirSync(storeIndexPath(root));
  assert.throws(() => readWorkflowStoreIndex(storeIndexPath(root)), (e: unknown) =>
    e instanceof StoreIndexError && /not a regular file/.test(e.message));
});

test('index: writing through a symlinked parent is refused', () => {
  const root = tempDir();
  const realParent = join(root, 'real');
  mkdirSync(realParent);
  const linkedParent = join(root, 'linked');
  symlinkSync(realParent, linkedParent);
  assert.throws(() => writeWorkflowStoreIndex(join(linkedParent, 'index.json'), emptyWorkflowStoreIndex()), (e: unknown) =>
    e instanceof StoreIndexError && /parent .* is a symlink/.test(e.message));
});

// ---- branded types -----------------------------------------------------------------

test('defDigest/isDefDigest: lowercase 64-hex only — never normalized', () => {
  assert.ok(isDefDigest('a'.repeat(64)));
  assert.equal(defDigest('0123456789abcdef'.repeat(4)), '0123456789abcdef'.repeat(4));
  assert.throws(() => defDigest('A'.repeat(64)), StoreDigestError); // uppercase rejected
  assert.throws(() => defDigest('a'.repeat(63)), StoreDigestError); // short rejected
  assert.throws(() => defDigest('g'.repeat(64)), StoreDigestError); // non-hex rejected
  assert.ok(!isDefDigest('A'.repeat(64)));
  assert.equal(DIGEST_RE.source, '^[0-9a-f]{64}$');
});

test('workflowCoordinate: components are validated, assembled as namespace/name@version', () => {
  assert.equal(workflowCoordinate({ namespace: 'acme', name: 'widget', version: '1.0.0' }), 'acme/widget@1.0.0');
  assert.throws(() => workflowCoordinate({ namespace: '', name: 'w', version: '1' }), (e: unknown) =>
    e instanceof StoreCoordinateError && /namespace is empty/.test(e.message));
  assert.throws(() => workflowCoordinate({ namespace: 'a', name: 'b:c', version: '1' }), StoreCoordinateError); // ':' is path-significant
  assert.throws(() => workflowCoordinate({ namespace: 'a', name: 'b\x00c', version: '1' }), StoreCoordinateError); // control char
  assert.throws(() => workflowCoordinate({ namespace: 'a', name: 'b', version: '1/2' }), StoreCoordinateError); // separator
});

test('parseWorkflowCoordinate: version splits at the FINAL @, name at the FIRST /', () => {
  assert.deepEqual(parseWorkflowCoordinate('acme/widget@1.0.0'), { namespace: 'acme', name: 'widget', version: '1.0.0' });
  // '@' is legal INSIDE the name component: the version split is at the final '@'.
  assert.deepEqual(parseWorkflowCoordinate('acme/widget@1@2'), { namespace: 'acme', name: 'widget@1', version: '2' });

  const bad = ['acme/widget', 'acme/widget@', '@1', '/name@1', 'ns/@1', 'a/b/c@1'];
  for (const text of bad) {
    assert.throws(() => parseWorkflowCoordinate(text), StoreCoordinateError, `expected rejection of ${JSON.stringify(text)}`);
  }
});

test('objectDirForDigest: the path derives ONLY from the validated digest', () => {
  const root = tempDir();
  const d = digest('d');
  assert.equal(objectDirForDigest(root, d), join(root, 'objects', 'sha256', d));
});

// ---- digest-only resolution (the execution API) ------------------------------------

test('resolveWorkflowDigest: a present project object resolves at project level', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const d = digest('e');
  const dir = seedObject(projectRoot, d);
  const verifier = resolvingVerifier();

  const res = await resolveWorkflowDigest({ digest: d, projectRoot, globalRoot, verifier });

  assert.equal(res.level, 'project');
  assert.equal(res.objectPath, dir);
  assert.deepEqual(res.presentAt, { project: true, global: false });
  assert.deepEqual(verifier.calls, [{ objectDir: dir, digest: d }], 'the returned object is verified before use');
});

test('resolveWorkflowDigest: the SAME digest at both levels is ONE result (project wins, global is metadata)', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const d = digest('f');
  const projectDir = seedObject(projectRoot, d);
  seedObject(globalRoot, d);
  const verifier = resolvingVerifier();

  const res = await resolveWorkflowDigest({ digest: d, projectRoot, globalRoot, verifier });

  assert.equal(res.level, 'project');
  assert.equal(res.objectPath, projectDir);
  assert.deepEqual(res.presentAt, { project: true, global: true });
  assert.equal(verifier.calls.length, 1, 'only the returned (project) copy is verified');
});

test('resolveWorkflowDigest: an ABSENT project object falls through to global', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const d = digest('0');
  const globalDir = seedObject(globalRoot, d);

  const res = await resolveWorkflowDigest({ digest: d, projectRoot, globalRoot, verifier: resolvingVerifier() });

  assert.equal(res.level, 'global');
  assert.equal(res.objectPath, globalDir);
  assert.deepEqual(res.presentAt, { project: false, global: true });
});

test('resolveWorkflowDigest: no project root means global-only resolution', async () => {
  const globalRoot = tempDir();
  const d = digest('1');
  const globalDir = seedObject(globalRoot, d);

  const res = await resolveWorkflowDigest({ digest: d, globalRoot, verifier: resolvingVerifier() });

  assert.equal(res.level, 'global');
  assert.equal(res.objectPath, globalDir);
  assert.deepEqual(res.presentAt, { project: false, global: true });
});

test('resolveWorkflowDigest: a digest present nowhere is object-missing', async () => {
  await assert.rejects(
    resolveWorkflowDigest({ digest: digest('2'), projectRoot: tempDir(), globalRoot: tempDir(), verifier: resolvingVerifier() }),
    (e: unknown) => e instanceof StoreIntegrityError && e.code === 'object-missing'
      && /not present in the project or global workflow store/.test(e.message),
  );
});

test('resolveWorkflowDigest: a CORRUPT project object is a hard error — never masked by a valid global copy', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const d = digest('3');
  // A symlink squatting at the project object path; a perfectly good global copy exists.
  const squatted = objectDirForDigest(projectRoot, d);
  mkdirSync(join(squatted, '..'), { recursive: true });
  symlinkSync(tempDir(), squatted);
  seedObject(globalRoot, d);

  await assert.rejects(
    resolveWorkflowDigest({ digest: d, projectRoot, globalRoot, verifier: resolvingVerifier() }),
    (e: unknown) => e instanceof StoreIntegrityError && e.code === 'object-corrupt'
      && /project-level object dir is a symlink/.test(e.message),
  );
});

test('resolveWorkflowDigest: a failed verification is object-corrupt, wrapping the adapter error', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const d = digest('4');
  const dir = seedObject(projectRoot, d);

  await assert.rejects(
    resolveWorkflowDigest({ digest: d, projectRoot, globalRoot, verifier: resolvingVerifier({ failFor: new Set([dir]) }) }),
    (e: unknown) => e instanceof StoreIntegrityError && e.code === 'object-corrupt'
      && /failed verification/.test(e.message),
  );
});

test('resolveWorkflowDigest: a symlinked store root is refused before any fallback', async () => {
  const projectRoot = tempDir();
  const linkedRoot = join(tempDir(), 'linked');
  symlinkSync(projectRoot, linkedRoot);

  await assert.rejects(
    resolveWorkflowDigest({ digest: digest('5'), projectRoot: linkedRoot, globalRoot: tempDir(), verifier: resolvingVerifier() }),
    StorePathError,
  );
});

// ---- coordinate resolution (the human API) ------------------------------------------

test('resolveWorkflowCoordinate: one entry at one level resolves and verifies its object', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const d = digest('6');
  const dir = seedObject(globalRoot, d);
  writeIndex(globalRoot, { 'acme/widget@1.0.0': { digest: d, pinned: false } });
  const verifier = resolvingVerifier();

  const res = await resolveWorkflowCoordinate({
    coordinate: workflowCoordinate({ namespace: 'acme', name: 'widget', version: '1.0.0' }),
    projectRoot, globalRoot, verifier,
  });

  assert.equal(res.level, 'global');
  assert.equal(res.objectPath, dir);
  assert.deepEqual(res.presentAt, { project: false, global: true });
  assert.equal(verifier.calls.length, 1);
});

test('resolveWorkflowCoordinate: same digest at BOTH levels deduplicates to one project-level result', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const d = digest('7');
  const projectDir = seedObject(projectRoot, d);
  writeIndex(projectRoot, { 'acme/widget@1.0.0': { digest: d, pinned: false } });
  writeIndex(globalRoot, { 'acme/widget@1.0.0': { digest: d, pinned: false } });

  const res = await resolveWorkflowCoordinate({
    coordinate: workflowCoordinate({ namespace: 'acme', name: 'widget', version: '1.0.0' }),
    projectRoot, globalRoot, verifier: resolvingVerifier(),
  });

  assert.equal(res.level, 'project');
  assert.equal(res.objectPath, projectDir);
  assert.deepEqual(res.presentAt, { project: true, global: true });
});

test('resolveWorkflowCoordinate: a missing coordinate is StoreNotFoundError (never a guess)', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  writeIndex(projectRoot, {});
  writeIndex(globalRoot, {});

  await assert.rejects(
    resolveWorkflowCoordinate({
      coordinate: workflowCoordinate({ namespace: 'acme', name: 'ghost', version: '9.9.9' }),
      projectRoot, globalRoot, verifier: resolvingVerifier(),
    }),
    (e: unknown) => e instanceof StoreNotFoundError && e.code === 'coordinate-not-found'
      && e.coordinate === 'acme/ghost@9.9.9' && /is not in the workflow store index/.test(e.message),
  );
});

test('resolveWorkflowCoordinate: DIFFERENT digests at the two levels are an ambiguity error carrying BOTH digests', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const projectDigest = digest('8');
  const globalDigest = digest('9');
  seedObject(projectRoot, projectDigest);
  seedObject(globalRoot, globalDigest);
  writeIndex(projectRoot, { 'acme/widget@1.0.0': { digest: projectDigest, pinned: false } });
  writeIndex(globalRoot, { 'acme/widget@1.0.0': { digest: globalDigest, pinned: false } });

  await assert.rejects(
    resolveWorkflowCoordinate({
      coordinate: workflowCoordinate({ namespace: 'acme', name: 'widget', version: '1.0.0' }),
      projectRoot, globalRoot, verifier: resolvingVerifier(),
    }),
    (e: unknown) => e instanceof StoreAmbiguityError && e.code === 'coordinate-ambiguous'
      && e.projectDigest === projectDigest && e.globalDigest === globalDigest
      && /resolves to different digests/.test(e.message),
  );
});

test('resolveWorkflowCoordinate: an index entry whose object is missing is object-missing', async () => {
  const globalRoot = tempDir();
  const d = digest('a');
  writeIndex(globalRoot, { 'acme/widget@1.0.0': { digest: d, pinned: false } });
  // No object seeded.

  await assert.rejects(
    resolveWorkflowCoordinate({
      coordinate: workflowCoordinate({ namespace: 'acme', name: 'widget', version: '1.0.0' }),
      globalRoot, verifier: resolvingVerifier(),
    }),
    (e: unknown) => e instanceof StoreIntegrityError && e.code === 'object-missing'
      && /references a missing object/.test(e.message),
  );
});

test('resolveWorkflowCoordinate: a CORRUPT project index is a hard error (no silent fallback to global)', async () => {
  const projectRoot = tempDir();
  const globalRoot = tempDir();
  const d = digest('b');
  seedObject(globalRoot, d);
  writeIndex(globalRoot, { 'acme/widget@1.0.0': { digest: d, pinned: false } });
  writeFileSync(storeIndexPath(projectRoot), '{corrupt');

  await assert.rejects(
    resolveWorkflowCoordinate({
      coordinate: workflowCoordinate({ namespace: 'acme', name: 'widget', version: '1.0.0' }),
      projectRoot, globalRoot, verifier: resolvingVerifier(),
    }),
    StoreIndexError,
  );
});

// ---- error-class shape --------------------------------------------------------------

test('store errors: every refusal is a WorkflowStoreError with a stable code and structured fields', () => {
  const coord = workflowCoordinate({ namespace: 'acme', name: 'widget', version: '1.0.0' });

  const ambiguity = new StoreAmbiguityError(coord, 'a'.repeat(64), 'b'.repeat(64));
  assert.ok(ambiguity instanceof WorkflowStoreError);
  assert.equal(ambiguity.code, 'coordinate-ambiguous');
  assert.equal(ambiguity.coordinate, coord);

  const conflict = new StoreConflictError(coord, 'c'.repeat(64));
  assert.ok(conflict instanceof WorkflowStoreError);
  assert.equal(conflict.code, 'coordinate-conflict');
  assert.equal(conflict.existingDigest, 'c'.repeat(64));

  const integrity = new StoreIntegrityError('object-corrupt', 'd'.repeat(64), 'detail');
  assert.ok(integrity instanceof WorkflowStoreError);
  assert.equal(integrity.code, 'object-corrupt');
  assert.equal(integrity.digest, 'd'.repeat(64));

  const missing = new StoreNotFoundError(coord);
  assert.ok(missing instanceof WorkflowStoreError);
  assert.equal(missing.code, 'coordinate-not-found');

  assert.equal(new StorePathError('x').code, 'path-refused');
  assert.equal(new StoreDigestError('x').code, 'digest-invalid');
  assert.equal(new StoreCoordinateError('x').code, 'coordinate-invalid');
  assert.equal(new BundleIngestorUnavailableError().code, 'bundle-ingestor-unavailable');
  assert.equal(new PreCommitVerifierUnavailableError().code, 'pre-commit-verifier-unavailable');
});
