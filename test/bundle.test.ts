/** Deterministic .wnlp bundle API and hostile-archive tests. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  BundleError,
  digestBundle,
  inspectBundle,
  packBundle,
  unpackBundle,
} from '../src/bundle/index.ts';
import { manifestToBytes, parseManifestBytes } from '../src/bundle/manifest.ts';
import { BUNDLE_GZIP_LEVEL, buildCanonicalTar, collectSourceFiles, gzipDeterministic } from '../src/bundle/tar.ts';
import { hostileData, hostileFileEntry, hostileHeader, hostilePaxBlocks, hostilePaxPathRecord, hostileTarball } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'test', 'fixtures', 'bundle', 'golden-source');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'bundle', 'golden.wnlp');
const GOLDEN_JSON = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'bundle', 'golden.json'), 'utf8')) as {
  digest: string;
  entries: Array<{ path: string; size: number; sha256: string; executable: boolean }>;
};

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BundleError, `expected BundleError, got ${String(error)}`);
    return error.code;
  }
  assert.fail('expected the operation to throw');
}

function tempDir(prefix = 'owenloop-bundle-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('manifest parser rejects duplicate keys, aliases, merges, tags, and prototype keys', () => {
  const base = `formatVersion: 2\npackage:\n  name: x\n  version: "1"\nworkflows:\n  main: workflow.yaml\nplatforms: []\nintegrity:\n  algorithm: sha256\n  files: {}\ncapabilities: {}\nlock: {}\n`;
  const cases = [
    ['duplicate key', base.replace('formatVersion: 2\n', 'formatVersion: 2\nformatVersion: 2\n')],
    ['alias', base.replace('platforms: []', 'platforms: &platforms []').replace('capabilities: {}', 'capabilities: *platforms')],
    ['merge key', base.replace('capabilities: {}', 'capabilities:\n  <<: {}')],
    ['map tag', base.replace('package:\n', 'package: !x\n')],
    ['sequence tag', base.replace('platforms: []', 'platforms: !x []')],
    ['prototype key', base.replace('lock: {}', 'lock:\n  __proto__: value')],
  ] as const;
  for (const [name, text] of cases) {
    assert.equal(errorCode(() => parseManifestBytes(Buffer.from(text))), 'MANIFEST_ERROR', name);
  }
  assert.equal(
    errorCode(() => parseManifestBytes(Buffer.from(base.replace('formatVersion: 2', 'formatVersion: 1')))),
    'UNSUPPORTED_FORMAT_VERSION',
  );
  assert.equal(
    errorCode(() => parseManifestBytes(Buffer.from(base.replace('main: workflow.yaml', 'main: ../workflow.yaml')))),
    'MANIFEST_ERROR',
  );
  assert.equal(
    errorCode(() => parseManifestBytes(Buffer.from(`${base}entrypoint: workflow.yaml\n`))),
    'MANIFEST_ERROR',
  );
  assert.equal(
    errorCode(() => parseManifestBytes(Buffer.from(base.replace('workflows:\n  main: workflow.yaml', 'workflows: {}')))),
    'MANIFEST_ERROR',
  );
  assert.equal(
    errorCode(() => parseManifestBytes(Buffer.from(base.replace('main: workflow.yaml', 'Main: workflow.yaml')))),
    'MANIFEST_ERROR',
  );
  assert.equal(
    errorCode(() => parseManifestBytes(Buffer.from(base.replace('workflows:\n  main: workflow.yaml', 'workflows:\n  main: workflow.yaml\n  other: workflow.yaml')))),
    'MANIFEST_ERROR',
  );
  assert.equal(
    errorCode(() => parseManifestBytes(Buffer.from(`${base}default: missing\n`))),
    'MANIFEST_ERROR',
  );
});

test('golden source packs to the byte-identical canonical archive and digest', () => {
  const packed = packBundle(SOURCE);
  assert.equal(packed.digest, GOLDEN_JSON.digest);
  assert.deepEqual(packed.entries, GOLDEN_JSON.entries);

  // This pins every byte the packer lays down: USTAR headers, canonical modes,
  // PAX path records, ordering, padding, and the two-block terminator. The gzip
  // DEFLATE stream is not compared because linked zlib implementations may
  // encode this same canonical tar differently; bundle identity is its SHA-256.
  assert.deepEqual(gunzipSync(packed.bytes), gunzipSync(readFileSync(GOLDEN)));

  // Pin the header ranges Owenloop controls: magic/CM/FLG (bytes 0-3), MTIME
  // (bytes 4-7), and OS (byte 9). XFL (byte 8) is zlib-owned and unnormalized.
  const header = Buffer.from(packed.bytes.subarray(0, 10));
  assert.deepEqual(header.subarray(0, 4), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
  assert.deepEqual(header.subarray(4, 8), Buffer.alloc(4));
  assert.equal(header[9], 0);

  const inspected = inspectBundle(packed.bytes);
  assert.equal(inspected.digest, GOLDEN_JSON.digest);
  assert.deepEqual(inspected.entries, GOLDEN_JSON.entries);
});

test('gzip uses the documented compression level and header normalization', () => {
  const tar = gunzipSync(readFileSync(GOLDEN));
  assert.equal(BUNDLE_GZIP_LEVEL, 9);

  // This catches a hardcoded gzip level that drifts from the exported constant
  // without re-pinning XFL (byte 8), which is owned by the linked zlib build.
  const expected = gzipSync(tar, { level: BUNDLE_GZIP_LEVEL });
  expected[4] = 0;
  expected[5] = 0;
  expected[6] = 0;
  expected[7] = 0;
  expected[9] = 0;
  assert.deepEqual(gzipDeterministic(tar), expected);
});

test('bundle identity survives a different gzip compression of the same canonical tar', () => {
  // Never re-pin this vector to one zlib build's DEFLATE output: compression of
  // the same tar may differ while its bundle digest, entries, and manifest do not.
  const golden = readFileSync(GOLDEN);
  const tar = gunzipSync(golden);
  const recompressed = gzipSync(tar, { level: 1 });

  assert.notDeepEqual(Buffer.from(recompressed), golden);
  assert.equal(digestBundle(recompressed).digest, GOLDEN_JSON.digest);

  const inspected = inspectBundle(recompressed);
  assert.equal(inspected.digest, GOLDEN_JSON.digest);
  assert.deepEqual(inspected.entries, GOLDEN_JSON.entries);
});

test('inspect resolves step bodyFile from archive bytes and verifies integrity', () => {
  const inspected = inspectBundle(readFileSync(GOLDEN));
  assert.equal(inspected.manifest.package.name, 'golden-bundle');
  assert.equal(inspected.manifest.integrity.files['workflows/instructions/build.md']?.length, 64);
});

test('a subdirectory workflow refuses a bodyFile that sits at the archive root', () => {
  // The positive half is the golden fixture itself: workflows/golden.yaml
  // resolves `bodyFile: instructions/build.md` to its SIBLING,
  // workflows/instructions/build.md. This is the negative half — the same
  // authored `bodyFile` string with the file at the ARCHIVE ROOT
  // (instructions/build.md) must be REFUSED, because `bodyFile` is relative to
  // the workflow file's own directory, never to the archive root. Both the
  // pack-time disk loader and the in-memory archive reader must refuse it.

  // Pack side: the disk loader resolves against dirname(workflow file), so the
  // root-level body file is simply not there.
  const packSource = tempDir();
  cpSync(SOURCE, packSource, { recursive: true });
  mkdirSync(join(packSource, 'instructions'), { recursive: true });
  renameSync(
    join(packSource, 'workflows', 'instructions', 'build.md'),
    join(packSource, 'instructions', 'build.md'),
  );
  rmSync(join(packSource, 'workflows', 'instructions'), { recursive: true });
  assert.equal(errorCode(() => packBundle(packSource)), 'WORKFLOW_ERROR');

  // Inspect side: build the same layout directly as archive bytes, since pack
  // refuses to produce it. `buildArchive` keeps the integrity map honest so the
  // failure that surfaces is the bodyFile rule, not an integrity mismatch.
  const workflowBytes = readFileSync(join(SOURCE, 'workflows', 'golden.yaml'));
  const initBytes = readFileSync(join(SOURCE, 'workflows', 'init.yaml'));
  const bodyBytes = readFileSync(join(SOURCE, 'workflows', 'instructions', 'build.md'));
  const buildArchive = (bodyPath: string): Buffer => {
    const payload: Array<[string, Buffer]> = [
      ['workflows/golden.yaml', workflowBytes],
      ['workflows/init.yaml', initBytes],
      [bodyPath, bodyBytes],
    ];
    const base = parseManifestBytes(readFileSync(join(SOURCE, 'bundle.yaml')));
    const files: Record<string, string> = {};
    for (const [path, bytes] of payload) files[path] = createHash('sha256').update(bytes).digest('hex');
    const manifest = { ...base, integrity: { algorithm: 'sha256' as const, files } };
    const all: Array<[string, Buffer]> = [
      ['bundle.yaml', Buffer.from(manifestToBytes(manifest))],
      ...payload,
    ];
    all.sort((a, b) => Buffer.compare(Buffer.from(a[0], 'utf8'), Buffer.from(b[0], 'utf8')));
    return gzipSync(buildCanonicalTar(all.map(([path, bytes]) => ({ path, bytes, mode: 0o644 }))));
  };

  // Control: the sibling layout — the positive half — inspects cleanly, so the
  // negative assertion below isolates the base directory and nothing else.
  const sibling = inspectBundle(buildArchive('workflows/instructions/build.md'));
  assert.equal(sibling.manifest.package.name, 'golden-bundle');

  assert.equal(errorCode(() => inspectBundle(buildArchive('instructions/build.md'))), 'WORKFLOW_ERROR');
});

test('pack validates every declared workflow and aggregates cross-workflow lock coverage', () => {
  const missing = tempDir();
  cpSync(SOURCE, missing, { recursive: true });
  writeFileSync(
    join(missing, 'bundle.yaml'),
    readFileSync(join(missing, 'bundle.yaml'), 'utf8').replace('init: workflows/init.yaml', 'init: workflows/missing.yaml'),
  );
  assert.equal(errorCode(() => packBundle(missing)), 'WORKFLOW_MISSING');

  const wrongName = tempDir();
  cpSync(SOURCE, wrongName, { recursive: true });
  writeFileSync(
    join(wrongName, 'workflows', 'init.yaml'),
    readFileSync(join(wrongName, 'workflows', 'init.yaml'), 'utf8').replace('name: init', 'name: wrong'),
  );
  assert.equal(errorCode(() => packBundle(wrongName)), 'WORKFLOW_ERROR');

  const missingLock = tempDir();
  cpSync(SOURCE, missingLock, { recursive: true });
  writeFileSync(join(missingLock, 'workflows', 'init.yaml'), `name: init
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: initialize
    calls: acme/child@1.0.0
    inputs:
      seed: seed
    produces: [out]
`);
  assert.equal(errorCode(() => packBundle(missingLock)), 'MANIFEST_ERROR');
});

test('def digest is SHA-256 over independently gunzipped tar bytes', () => {
  const bytes = readFileSync(GOLDEN);
  const tar = gunzipSync(bytes);
  const expected = createHash('sha256').update(tar).digest('hex');
  assert.equal(digestBundle(bytes).digest, expected);
});

test('every canonical-tar byte mutation is rejected or changes logical identity', () => {
  const packed = packBundle(SOURCE);
  const baseline = inspectBundle(packed.bytes);
  const baselineMeaning = { manifest: baseline.manifest, entries: baseline.entries };
  const tar = gunzipSync(packed.bytes);
  for (let offset = 0; offset < tar.length; offset += 1) {
    const mutated = Buffer.from(tar);
    mutated[offset] = (mutated[offset] ?? 0) ^ 0xff;
    try {
      const inspected = inspectBundle(gzipSync(mutated));
      assert.notEqual(inspected.digest, baseline.digest, `byte mutation at offset ${offset} kept the digest`);
      const mutatedMeaning = { manifest: inspected.manifest, entries: inspected.entries };
      assert.notDeepEqual(mutatedMeaning, baselineMeaning, `byte mutation at offset ${offset} changed only unconstrained bytes`);
    } catch (error) {
      if (error instanceof BundleError) continue;
      throw error;
    }
  }
});

test('packing does not edit source manifest and is stable across mtime and irrelevant mode changes', () => {
  const source = tempDir();
  cpSync(SOURCE, source, { recursive: true });
  const before = readFileSync(join(source, 'bundle.yaml'));
  const first = packBundle(source);
  const changed = new Date('2001-02-03T04:05:06.000Z');
  for (const path of [
    join(source, 'bundle.yaml'),
    join(source, 'workflows', 'golden.yaml'),
    join(source, 'workflows', 'init.yaml'),
    join(source, 'workflows', 'instructions', 'build.md'),
  ]) {
    utimesSync(path, changed, changed);
  }
  chmodSync(join(source, 'workflows', 'instructions', 'build.md'), 0o600);
  const second = packBundle(source);
  assert.deepEqual(Buffer.from(second.bytes), Buffer.from(first.bytes));
  assert.deepEqual(readFileSync(join(source, 'bundle.yaml')), before);
});

test('one-file mutation changes archive bytes and digest', () => {
  const source = tempDir();
  cpSync(SOURCE, source, { recursive: true });
  const first = packBundle(source);
  writeFileSync(join(source, 'docs', 'README.md'), 'changed\n');
  const second = packBundle(source);
  assert.notEqual(second.digest, first.digest);
  assert.notDeepEqual(Buffer.from(second.bytes), Buffer.from(first.bytes));
});

test('packing is stable across controlled source directory-entry ordering', () => {
  const relativePaths = [
    'assets/binary.bin',
    'assets/notes.txt',
    'assets/very-long-directory-name-that-pushes-the-archive-path-past-one-hundred-bytes-to-require-a-pax-header/deeply-nested-file.txt',
    'bundle.yaml',
    'docs/README.md',
    'workflows/golden.yaml',
    'workflows/init.yaml',
    'workflows/instructions/build.md',
    'scripts/run.sh',
  ];
  const sourceFiles = relativePaths.map((rel) => ({
    rel,
    bytes: readFileSync(join(SOURCE, rel)),
    mode: rel === 'scripts/run.sh' ? 0o755 : 0o644,
  }));
  const buildSource = (files: typeof sourceFiles): string => {
    const root = tempDir();
    for (const file of files) {
      const target = join(root, file.rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
      chmodSync(target, file.mode);
    }
    return root;
  };

  const forward = packBundle(buildSource(sourceFiles));
  const reverse = packBundle(buildSource([...sourceFiles].reverse()));
  assert.equal(reverse.digest, forward.digest);
  assert.deepEqual(Buffer.from(reverse.bytes), Buffer.from(forward.bytes));

  // Drive the recursive walk with a deliberately reversed directory-entry
  // source. The test does not rely on the host filesystem's readdir ordering.
  const source = tempDir();
  mkdirSync(join(source, 'a'));
  mkdirSync(join(source, 'b'));
  writeFileSync(join(source, 'a', 'nested'), 'a');
  writeFileSync(join(source, 'a-file'), 'a-file');
  writeFileSync(join(source, 'b', 'child'), 'b');
  writeFileSync(join(source, 'root'), 'root');
  const visits: string[] = [];
  const reverseRead = (directory: string) => [...readdirSync(directory, { withFileTypes: true })].reverse();
  const collected = collectSourceFiles(source, undefined, {
    readDir: reverseRead,
    onVisit: (relativePath) => visits.push(relativePath),
  });
  assert.deepEqual(visits, ['a', 'a/nested', 'a-file', 'b', 'b/child', 'root']);
  assert.deepEqual(collected.map((file) => file.rel), ['a-file', 'a/nested', 'b/child', 'root']);

  const canonicalTar = (files: typeof collected): Buffer => buildCanonicalTar(files.map((file) => ({
    path: file.rel,
    bytes: readFileSync(file.abs),
    mode: file.executable ? 0o755 : 0o644,
  })));
  const forwardCollected = collectSourceFiles(source, undefined, {
    readDir: (directory) => readdirSync(directory, { withFileTypes: true }),
  });
  assert.deepEqual(canonicalTar(collected), canonicalTar(forwardCollected));
});

test('unpack validates before writing and leaves no destination on failure', () => {
  const root = tempDir();
  const destination = join(root, 'out');
  const malformed = hostileTarball(hostileFileEntry('../victim.txt', 'nope'));
  assert.equal(errorCode(() => unpackBundle(malformed, destination)), 'ARCHIVE_PATH_VIOLATION');
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(root), []);
});

test('unpack writes a fresh destination atomically and rejects overwrite', () => {
  const root = tempDir();
  const destination = join(root, 'out');
  const result = unpackBundle(readFileSync(GOLDEN), destination);
  assert.equal(result.path, destination);
  assert.equal(
    readFileSync(join(destination, 'workflows', 'instructions', 'build.md'), 'utf8'),
    readFileSync(join(SOURCE, 'workflows', 'instructions', 'build.md'), 'utf8'),
  );
  assert.equal(errorCode(() => unpackBundle(readFileSync(GOLDEN), destination)), 'DESTINATION_EXISTS');
});

test('unpack refuses invalid destination ancestors', () => {
  const root = tempDir();
  const real = join(root, 'real');
  const alias = join(root, 'alias');
  const fileParent = join(root, 'file-parent');
  mkdirSync(real);
  symlinkSync(real, alias);
  writeFileSync(fileParent, 'not a directory');
  assert.equal(errorCode(() => unpackBundle(readFileSync(GOLDEN), join(alias, 'out'))), 'DESTINATION_PARENT_INVALID');
  assert.equal(errorCode(() => unpackBundle(readFileSync(GOLDEN), join(fileParent, 'nested', 'out'))), 'DESTINATION_PARENT_INVALID');
  assert.deepEqual(readdirSync(real), []);
});

test('stock tar can list a produced bundle', () => {
  const root = tempDir();
  const path = join(root, 'golden.wnlp');
  writeFileSync(path, packBundle(SOURCE).bytes);
  const listing = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' });
  assert.match(listing, /bundle\.yaml/);
  assert.match(listing, /workflows\/golden\.yaml/);
  assert.match(listing, /workflows\/init\.yaml/);
});

test('strict reader rejects hostile path, duplicate, type, checksum, PAX, termination, and size cases', () => {
  const longPaxPath = 'p'.repeat(101);
  const cases: Array<[string, Uint8Array, string]> = [
    ['traversal', hostileTarball(hostileFileEntry('../victim', 'x')), 'ARCHIVE_PATH_VIOLATION'],
    ['absolute', hostileTarball(hostileFileEntry('/etc/passwd', 'x')), 'ARCHIVE_PATH_VIOLATION'],
    ['duplicate', hostileTarball([...hostileFileEntry('same', 'a'), ...hostileFileEntry('same', 'b')]), 'ARCHIVE_DUPLICATE_PATH'],
    ['symlink', hostileTarball([hostileHeader({ name: 'link', typeflag: '2' }), hostileData(new Uint8Array())]), 'UNSUPPORTED_ENTRY_TYPE'],
    ['hard link', hostileTarball([hostileHeader({ name: 'link', typeflag: '1' }), hostileData(new Uint8Array())]), 'UNSUPPORTED_ENTRY_TYPE'],
    ['block device', hostileTarball([hostileHeader({ name: 'device', typeflag: '3' }), hostileData(new Uint8Array())]), 'UNSUPPORTED_ENTRY_TYPE'],
    ['character device', hostileTarball([hostileHeader({ name: 'device', typeflag: '4' }), hostileData(new Uint8Array())]), 'UNSUPPORTED_ENTRY_TYPE'],
    ['directory', hostileTarball([hostileHeader({ name: 'dir', typeflag: '5' }), hostileData(new Uint8Array())]), 'UNSUPPORTED_ENTRY_TYPE'],
    ['fifo', hostileTarball([hostileHeader({ name: 'fifo', typeflag: '6' }), hostileData(new Uint8Array())]), 'UNSUPPORTED_ENTRY_TYPE'],
    ['unknown type', hostileTarball([hostileHeader({ name: 'unknown', typeflag: '7' }), hostileData(new Uint8Array())]), 'UNSUPPORTED_ENTRY_TYPE'],
    ['bad checksum', hostileTarball(hostileFileEntry('bad', 'x', { mutate: (header) => { header[0] = header[0] === 0x62 ? 0x63 : 0x62; } })), 'ARCHIVE_BAD_CHECKSUM'],
    ['bad octal', hostileTarball(hostileFileEntry('bad-octal', 'x', { badOctalField: { offset: 100, bytes: '00000x0' } })), 'ARCHIVE_BAD_OCTAL'],
    ['non-canonical mode', hostileTarball(hostileFileEntry('mode', 'x', { mode: 0o600 })), 'NON_CANONICAL_HEADER'],
    ['non-canonical linkname', hostileTarball(hostileFileEntry('linkname', 'x', { linkname: '../../etc/shadow' })), 'NON_CANONICAL_HEADER'],
    ['non-canonical PAX raw name', hostileTarball([
      ...hostilePaxBlocks('PaxHeader', hostilePaxPathRecord(longPaxPath)),
      ...hostileFileEntry('wrong-placeholder', 'x'),
    ]), 'NON_CANONICAL_HEADER'],
    ['bad pax', hostileTarball([...hostilePaxBlocks('PaxHeader', Buffer.from('not-a-record\n')), ...hostileFileEntry('data', 'x')]), 'ARCHIVE_BAD_PAX'],
    ['dangling pax', hostileTarball(hostilePaxBlocks('PaxHeader', hostilePaxPathRecord('dangling'))), 'ARCHIVE_DANGLING_PAX'],
    ['truncated data', hostileTarball([hostileHeader({ name: 'truncated', size: 2 }), Buffer.from('x')]), 'ARCHIVE_TRUNCATED'],
    ['truncated padding', hostileTarball([hostileHeader({ name: 'padding', size: 1 }), Buffer.from('x')]), 'ARCHIVE_TRUNCATED'],
    ['missing terminator', hostileTarball(hostileFileEntry('data', 'x'), { terminator: 'missing' }), 'ARCHIVE_TRUNCATED'],
    ['one terminator block', hostileTarball(hostileFileEntry('data', 'x'), { terminator: 'one' }), 'ARCHIVE_TRUNCATED'],
    ['trailing bytes', hostileTarball(hostileFileEntry('data', 'x'), { trailing: Buffer.from('trailing') }), 'ARCHIVE_TRAILING_BYTES'],
    ['missing manifest', hostileTarball(hostileFileEntry('data', 'x')), 'MANIFEST_MISSING'],
  ];
  for (const [name, bytes, expected] of cases) {
    assert.equal(errorCode(() => inspectBundle(bytes)), expected, name);
  }
  const longPath = 'a/'.repeat(600) + 'file';
  const pax = hostileTarball([...hostilePaxBlocks('PaxHeader', hostilePaxPathRecord(longPath)), ...hostileFileEntry(longPath.slice(0, 100), 'x')]);
  assert.equal(errorCode(() => inspectBundle(pax)), 'ARCHIVE_PATH_TOO_LONG');
  assert.equal(errorCode(() => inspectBundle(hostileTarball(hostileFileEntry('large', '123')),{ limits: { maxFileBytes: 2 } })), 'ARCHIVE_ENTRY_TOO_LARGE');
});

test('strict reader rejects a non-canonical manifest and a mutated file', () => {
  const source = tempDir();
  cpSync(SOURCE, source, { recursive: true });
  const packed = packBundle(source);

  // The source manifest is regenerated in memory, so authoring whitespace does
  // not leak into the archive. A real archive mutation must still be refused.
  const tar = gunzipSync(packed.bytes);
  assert.ok(tar.length > 0);
  const nonCanonicalTar = Buffer.from(tar);
  const manifestMarker = Buffer.from('name: "golden-bundle"', 'utf8');
  const markerOffset = nonCanonicalTar.indexOf(manifestMarker);
  assert.ok(markerOffset >= 0, 'fixture must contain the canonical package name');
  nonCanonicalTar[markerOffset + 'name: '.length] = 0x27;
  nonCanonicalTar[markerOffset + 'name: "'.length + Buffer.byteLength('golden-bundle', 'utf8')] = 0x27;
  assert.equal(errorCode(() => inspectBundle(gzipSync(nonCanonicalTar))), 'MANIFEST_ERROR');

  let offset = 0;
  let mutated = false;
  while (offset + 512 <= tar.length && !tar.subarray(offset, offset + 512).every((byte) => byte === 0)) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8);
    const dataStart = offset + 512;
    if (name === 'docs/README.md') {
      assert.ok(size > 0);
      tar[dataStart] = (tar[dataStart] ?? 0) ^ 0xff;
      mutated = true;
      break;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  assert.equal(mutated, true, 'fixture must contain the selected regular file');
  assert.equal(errorCode(() => inspectBundle(gzipSync(tar))), 'INTEGRITY_MISMATCH');

  const workflowTar = gunzipSync(packed.bytes);
  offset = 0;
  mutated = false;
  while (offset + 512 <= workflowTar.length && !workflowTar.subarray(offset, offset + 512).every((byte) => byte === 0)) {
    const header = workflowTar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8);
    const dataStart = offset + 512;
    if (name === 'workflows/init.yaml') {
      assert.ok(size > 0);
      workflowTar[dataStart + size - 1] = 0x20;
      mutated = true;
      break;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  assert.equal(mutated, true, 'fixture must contain the non-default workflow');
  assert.equal(errorCode(() => inspectBundle(gzipSync(workflowTar))), 'INTEGRITY_MISMATCH');

  assert.equal(errorCode(() => inspectBundle(packed.bytes, { limits: { maxExpandedBytes: tar.length - 1 } })), 'BUNDLE_LIMIT');
});
