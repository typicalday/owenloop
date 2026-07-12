/** Round-trips the from-scratch test/helpers.ts tar-gz writer through
 *  src/untar.ts's reader, so the reader is validated against an
 *  independently-implemented writer (not against itself). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
