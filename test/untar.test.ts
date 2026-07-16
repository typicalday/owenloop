/** Round-trips the from-scratch test/helpers.ts tar-gz writer through
 *  src/untar.ts's reader, so the reader is validated against an
 *  independently-implemented writer (not against itself). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { extractTarGz } from '../src/untar.ts';
import { makeGithubTarball } from './helpers.ts';

test('round-trips a small set of short-path files', () => {
  const tarball = makeGithubTarball('acme-widgets-abc123', {
    'workflows/foo.yaml': 'name: foo\n',
    'workflows/sub/bar.yaml': 'name: bar\n',
    'README.md': '# hi\n',
  });

  const files = extractTarGz(tarball);
  assert.equal(files.size, 3);
  assert.equal(
    Buffer.from(files.get('acme-widgets-abc123/workflows/foo.yaml')!).toString('utf8'),
    'name: foo\n',
  );
  assert.equal(
    Buffer.from(files.get('acme-widgets-abc123/workflows/sub/bar.yaml')!).toString('utf8'),
    'name: bar\n',
  );
  assert.equal(
    Buffer.from(files.get('acme-widgets-abc123/README.md')!).toString('utf8'),
    '# hi\n',
  );
});

test('round-trips a path over 100 chars via the pax "x" extended header', () => {
  const longSegment = 'a'.repeat(90);
  const longRelPath = `workflows/${longSegment}/deeply-nested-workflow-file.yaml`;
  assert.ok(longRelPath.length > 100 - 'acme-widgets-abc123/'.length, 'sanity: this path is genuinely long');

  const tarball = makeGithubTarball('acme-widgets-abc123', {
    [longRelPath]: 'name: long\n',
  });

  const files = extractTarGz(tarball);
  const fullPath = `acme-widgets-abc123/${longRelPath}`;
  assert.ok(fullPath.length > 100, 'sanity: the full in-archive path exceeds the 100-byte USTAR name field');
  assert.equal(files.size, 1);
  assert.ok(files.has(fullPath), `expected key ${fullPath}, got ${[...files.keys()]}`);
  assert.equal(Buffer.from(files.get(fullPath)!).toString('utf8'), 'name: long\n');
});

test('empty file contents round-trip correctly', () => {
  const tarball = makeGithubTarball('acme-widgets-abc123', { 'workflows/empty.yaml': '' });
  const files = extractTarGz(tarball);
  assert.equal(files.get('acme-widgets-abc123/workflows/empty.yaml')!.length, 0);
});

test('extractTarGz throws on corrupt/non-gzip bytes', () => {
  assert.throws(() => extractTarGz(new Uint8Array([1, 2, 3, 4, 5])));
});

// ---- resource bounds (SEC-1) -------------------------------------------------
// Limits are injected tiny so we never build a giant fixture.

test('extractTarGz rejects an archive with too many files', () => {
  const tarball = makeGithubTarball('acme-widgets-abc123', {
    'workflows/a.yaml': 'a\n',
    'workflows/b.yaml': 'b\n',
    'workflows/c.yaml': 'c\n',
  });
  assert.throws(
    () => extractTarGz(tarball, { maxFileCount: 2 }),
    /file count exceeds limit of 2/,
  );
});

test('extractTarGz rejects an entry over the per-file size limit', () => {
  const tarball = makeGithubTarball('acme-widgets-abc123', {
    'workflows/big.yaml': 'x'.repeat(100),
  });
  assert.throws(
    () => extractTarGz(tarball, { maxFileBytes: 10 }),
    /per-file size limit of 10 bytes/,
  );
});

test('extractTarGz rejects an input over the compressed-size limit', () => {
  const tarball = makeGithubTarball('acme-widgets-abc123', { 'workflows/foo.yaml': 'name: foo\n' });
  assert.throws(
    () => extractTarGz(tarball, { maxCompressedBytes: 1 }),
    /compressed archive size \d+ exceeds limit of 1 bytes/,
  );
});

test('extractTarGz aborts a gzip bomb at inflate time (expanded-size limit)', () => {
  // Highly compressible: 1 MiB of zeros gzips to a few hundred bytes but
  // inflates well past a tiny maxExpandedBytes.
  const bomb = gzipSync(Buffer.alloc(1024 * 1024));
  assert.throws(
    () => extractTarGz(bomb, { maxExpandedBytes: 4096 }),
    /expanded archive size exceeds limit of 4096 bytes/,
  );
});

test('extractTarGz rejects an entry path over the path-length limit', () => {
  // A path over 100 bytes is emitted via a pax 'x' header; the limit is
  // enforced on the final resolved name.
  const longRelPath = `workflows/${'a'.repeat(90)}/deeply-nested-workflow-file.yaml`;
  const tarball = makeGithubTarball('acme-widgets-abc123', { [longRelPath]: 'name: long\n' });
  assert.throws(
    () => extractTarGz(tarball, { maxPathLength: 50 }),
    /path length \d+ exceeds limit of 50 chars/,
  );
});

test('extractTarGz still round-trips a normal archive under default limits', () => {
  const tarball = makeGithubTarball('acme-widgets-abc123', {
    'workflows/foo.yaml': 'name: foo\n',
  });
  const files = extractTarGz(tarball);
  assert.equal(files.size, 1);
  assert.equal(
    Buffer.from(files.get('acme-widgets-abc123/workflows/foo.yaml')!).toString('utf8'),
    'name: foo\n',
  );
});
