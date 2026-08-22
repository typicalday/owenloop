import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readSubmitValueFile } from '../src/submit-file.ts';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'owenloop-submit-file-'));
}

test('reads valid JSON from a relative file inside the workdir', async () => {
  const workdir = makeDir();
  try {
    writeFileSync(join(workdir, 'receipt.json'), JSON.stringify({ accepted: true, count: 2 }), 'utf8');
    assert.deepEqual(await readSubmitValueFile(workdir, 'receipt.json'), { accepted: true, count: 2 });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('reads an absolute JSON file inside the workdir', async () => {
  const workdir = makeDir();
  try {
    const receipt = join(workdir, 'receipt.json');
    writeFileSync(receipt, JSON.stringify(['one', 'two']), 'utf8');
    assert.deepEqual(await readSubmitValueFile(workdir, receipt), ['one', 'two']);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('refuses traversal and absolute paths outside the workdir before reading', async () => {
  const parent = makeDir();
  const workdir = join(parent, 'workdir');
  const outside = join(parent, 'outside.json');
  mkdirSync(workdir);
  writeFileSync(outside, JSON.stringify({ private: true }), 'utf8');
  try {
    await assert.rejects(
      readSubmitValueFile(workdir, '../outside.json'),
      /submit-value-file-outside-workdir.*\.\.\/outside\.json/u,
    );
    await assert.rejects(
      readSubmitValueFile(workdir, outside),
      /submit-value-file-outside-workdir.*outside\.json/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('refuses an in-workdir symlink whose canonical target is outside', async () => {
  const parent = makeDir();
  const workdir = join(parent, 'workdir');
  const outside = join(parent, 'outside.json');
  mkdirSync(workdir);
  writeFileSync(outside, JSON.stringify({ private: true }), 'utf8');
  symlinkSync(outside, join(workdir, 'linked.json'));
  try {
    await assert.rejects(
      readSubmitValueFile(workdir, 'linked.json'),
      /submit-value-file-outside-workdir.*linked\.json/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('reports missing and unreadable file inputs with the supplied path', async () => {
  const workdir = makeDir();
  mkdirSync(join(workdir, 'directory.json'));
  try {
    await assert.rejects(
      readSubmitValueFile(workdir, 'missing.json'),
      /submit-value-file-read-failed.*missing\.json/u,
    );
    await assert.rejects(
      readSubmitValueFile(workdir, 'directory.json'),
      /submit-value-file-read-failed.*directory\.json/u,
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('reports malformed JSON locally with the supplied path', async () => {
  const workdir = makeDir();
  try {
    writeFileSync(join(workdir, 'bad.json'), '{ nope', 'utf8');
    await assert.rejects(
      readSubmitValueFile(workdir, 'bad.json'),
      /submit-value-file-invalid-json.*bad\.json/u,
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
