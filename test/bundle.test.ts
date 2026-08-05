/** Deterministic .wnlp bundle API and hostile-archive tests. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
import { parseManifestBytes } from '../src/bundle/manifest.ts';
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
  const base = `formatVersion: 1\npackage:\n  name: x\n  version: "1"\nentrypoint: workflow.yaml\nplatforms: []\nintegrity:\n  algorithm: sha256\n  files: {}\ncapabilities: {}\nlock: {}\n`;
  const cases = [
    ['duplicate key', base.replace('formatVersion: 1\n', 'formatVersion: 1\nformatVersion: 1\n')],
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
    errorCode(() => parseManifestBytes(Buffer.from(base.replace('formatVersion: 1', 'formatVersion: 2')))),
    'UNSUPPORTED_FORMAT_VERSION',
  );
  assert.equal(
    errorCode(() => parseManifestBytes(Buffer.from(base.replace('entrypoint: workflow.yaml', 'entrypoint: ../workflow.yaml')))),
    'MANIFEST_ERROR',
  );
});

test('golden source packs to byte-identical archive and digest', () => {
  const packed = packBundle(SOURCE);
  assert.equal(packed.digest, GOLDEN_JSON.digest);
  assert.deepEqual(packed.entries, GOLDEN_JSON.entries);
  assert.deepEqual(Buffer.from(packed.bytes), readFileSync(GOLDEN));

  const inspected = inspectBundle(packed.bytes);
  assert.equal(inspected.digest, GOLDEN_JSON.digest);
  assert.deepEqual(inspected.entries, GOLDEN_JSON.entries);
});

test('inspect resolves step bodyFile from archive bytes and verifies integrity', () => {
  const inspected = inspectBundle(readFileSync(GOLDEN));
  assert.equal(inspected.manifest.package.name, 'golden-bundle');
  assert.equal(inspected.manifest.integrity.files['instructions/build.md']?.length, 64);
});

test('def digest is SHA-256 over independently gunzipped tar bytes', () => {
  const bytes = readFileSync(GOLDEN);
  const tar = gunzipSync(bytes);
  const expected = createHash('sha256').update(tar).digest('hex');
  assert.equal(digestBundle(bytes).digest, expected);
});

test('packing does not edit source manifest and is stable across mtime and irrelevant mode changes', () => {
  const source = tempDir();
  cpSync(SOURCE, source, { recursive: true });
  const before = readFileSync(join(source, 'bundle.yaml'));
  const first = packBundle(source);
  const changed = new Date('2001-02-03T04:05:06.000Z');
  for (const path of [join(source, 'bundle.yaml'), join(source, 'workflow.yaml'), join(source, 'instructions', 'build.md')]) {
    utimesSync(path, changed, changed);
  }
  chmodSync(join(source, 'instructions', 'build.md'), 0o600);
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

test('packing is stable across source directory-entry ordering', () => {
  const relativePaths = [
    'assets/binary.bin',
    'assets/notes.txt',
    'assets/very-long-directory-name-that-pushes-the-archive-path-past-one-hundred-bytes-to-require-a-pax-header/deeply-nested-file.txt',
    'bundle.yaml',
    'docs/README.md',
    'instructions/build.md',
    'scripts/run.sh',
    'workflow.yaml',
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
  assert.equal(readFileSync(join(destination, 'instructions', 'build.md'), 'utf8'), readFileSync(join(SOURCE, 'instructions', 'build.md'), 'utf8'));
  assert.equal(errorCode(() => unpackBundle(readFileSync(GOLDEN), destination)), 'DESTINATION_EXISTS');
});

test('unpack refuses a symlinked destination ancestor', () => {
  const root = tempDir();
  const real = join(root, 'real');
  const alias = join(root, 'alias');
  mkdirSync(real);
  symlinkSync(real, alias);
  assert.equal(errorCode(() => unpackBundle(readFileSync(GOLDEN), join(alias, 'out'))), 'DESTINATION_PARENT_INVALID');
  assert.deepEqual(readdirSync(real), []);
});

test('stock tar can list a produced bundle', () => {
  const root = tempDir();
  const path = join(root, 'golden.wnlp');
  writeFileSync(path, packBundle(SOURCE).bytes);
  const listing = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' });
  assert.match(listing, /bundle\.yaml/);
  assert.match(listing, /workflow\.yaml/);
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

  assert.equal(errorCode(() => inspectBundle(packed.bytes, { limits: { maxExpandedBytes: tar.length - 1 } })), 'BUNDLE_LIMIT');
});
