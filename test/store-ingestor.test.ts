import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { manifestToBytes, parseManifestBytes } from '../src/bundle/manifest.ts';
import { SUPPORTED_RUNTIME_FEATURES } from '../src/bundle/runtime.ts';
import { createBundleIngestor } from '../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

const WORKFLOW = `name: ingestor-fixture
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: runner
    consumes: [seed]
    produces: [out]
    terminal: true
    executor: command
    command: 'printf "local\\n"'
    body: ""
`;

function sourceDir(runtimeYaml?: string): string {
  return writeBundleSource({
    name: 'ingestor-fixture',
    workflow: WORKFLOW,
    ...(runtimeYaml === undefined ? {} : { runtimeYaml }),
    files: { 'notes/readme.txt': 'fixture note\n' },
  });
}

function makeWritable(objectPath: string, filePath?: string): void {
  chmodSync(objectPath, 0o755);
  if (filePath !== undefined) chmodSync(filePath, 0o644);
}

async function installedFixture(): Promise<{
  objectPath: string;
  digest: Parameters<ReturnType<typeof createBundleIngestor>['verifyInstalledObject']>[0]['digest'];
}> {
  const installed = await installBundleFixture({ sourceDir: sourceDir() });
  return { objectPath: installed.result.objectPath, digest: installed.result.digest };
}

test('store ingestor: a real packBundle archive installs and verifies as an immutable object', async () => {
  const installed = await installBundleFixture({ sourceDir: sourceDir() });
  const ingestor = createBundleIngestor();

  await ingestor.verifyInstalledObject({
    objectDir: installed.result.objectPath,
    digest: installed.result.digest,
  });

  assert.equal(installed.result.installed, true);
  assert.equal(installed.result.coordinate, 'ingestor-fixture/ingestor-fixture@1.0.0');
  assert.deepEqual(installed.result.workflows, ['ingestor-fixture']);
  assert.equal(readFileSync(join(installed.result.objectPath, 'workflow.yaml'), 'utf8'), WORKFLOW);
  assert.equal(readFileSync(join(installed.result.objectPath, 'notes', 'readme.txt'), 'utf8'), 'fixture note\n');
});

test('store ingestor: a compatible runtime declaration installs and verifies', async () => {
  const installed = await installBundleFixture({
    sourceDir: sourceDir([
      'minVersion: "0.5.0"',
      'features:',
      ...SUPPORTED_RUNTIME_FEATURES.map((feature) => `  - "${feature}"`),
    ].join('\n')),
  });

  await createBundleIngestor().verifyInstalledObject({
    objectDir: installed.result.objectPath,
    digest: installed.result.digest,
  });
  assert.deepEqual(
    parseManifestBytes(readFileSync(join(installed.result.objectPath, 'bundle.yaml'))).runtime,
    { minVersion: '0.5.0', features: [...SUPPORTED_RUNTIME_FEATURES] },
  );
});

test('store ingestor: runtime-only bundle.yaml mutation or removal fails canonical digest verification', async () => {
  for (const mutation of ['change', 'remove'] as const) {
    const installed = await installBundleFixture({
      sourceDir: sourceDir(`features:\n  - "${SUPPORTED_RUNTIME_FEATURES[0]}"`),
    });
    const manifestPath = join(installed.result.objectPath, 'bundle.yaml');
    makeWritable(installed.result.objectPath, manifestPath);
    const manifest = parseManifestBytes(readFileSync(manifestPath));
    const mutated = mutation === 'remove'
      ? { ...manifest, runtime: undefined }
      : { ...manifest, runtime: { features: [...SUPPORTED_RUNTIME_FEATURES] } };
    writeFileSync(manifestPath, manifestToBytes(mutated));

    await assert.rejects(
      createBundleIngestor().verifyInstalledObject({
        objectDir: installed.result.objectPath,
        digest: installed.result.digest,
      }),
      /canonical bundle digest mismatch/,
      mutation,
    );
  }
});

test('store ingestor: executable identity survives read-only hardening and canonical verification', async () => {
  const source = sourceDir();
  const executable = join(source, 'run.sh');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  const installed = await installBundleFixture({ sourceDir: source });

  assert.equal(statSync(join(installed.result.objectPath, 'run.sh')).mode & 0o777, 0o555);
  await createBundleIngestor().verifyInstalledObject({
    objectDir: installed.result.objectPath,
    digest: installed.result.digest,
  });
});

test('store ingestor: modified installed bytes fail the manifest integrity check', async () => {
  const { objectPath, digest } = await installedFixture();
  const target = join(objectPath, 'workflow.yaml');
  makeWritable(objectPath, target);
  writeFileSync(target, `${WORKFLOW}# tampered\n`);

  await assert.rejects(
    createBundleIngestor().verifyInstalledObject({ objectDir: objectPath, digest }),
    /integrity mismatch for 'workflow\.yaml'/,
  );
});

test('store ingestor: an added regular file not covered by integrity.files is refused', async () => {
  const { objectPath, digest } = await installedFixture();
  makeWritable(objectPath);
  writeFileSync(join(objectPath, 'unlisted.txt'), 'unexpected\n');

  await assert.rejects(
    createBundleIngestor().verifyInstalledObject({ objectDir: objectPath, digest }),
    /file 'unlisted\.txt' is not listed in bundle\.yaml integrity\.files/,
  );
});

test('store ingestor: deleting an integrity-listed file is refused', async () => {
  const { objectPath, digest } = await installedFixture();
  const target = join(objectPath, 'notes', 'readme.txt');
  makeWritable(objectPath);
  chmodSync(join(objectPath, 'notes'), 0o755);
  rmSync(target);

  await assert.rejects(
    createBundleIngestor().verifyInstalledObject({ objectDir: objectPath, digest }),
    /integrity map lists missing file .*notes\/readme\.txt/,
  );
});

test('store ingestor: replacing an integrity-listed file with a symlink is refused', async () => {
  const { objectPath, digest } = await installedFixture();
  const target = join(objectPath, 'workflow.yaml');
  const outside = join(tempDir('owenloop-store-outside-'), 'workflow.yaml');
  makeWritable(objectPath, target);
  writeFileSync(outside, WORKFLOW);
  rmSync(target);
  symlinkSync(outside, target);

  await assert.rejects(
    createBundleIngestor().verifyInstalledObject({ objectDir: objectPath, digest }),
    /object contains a symlink/,
  );
});

test('store ingestor: a missing, linked, or non-directory object path is refused', async () => {
  const ingestor = createBundleIngestor();
  const missing = join(tempDir(), 'missing');
  const root = tempDir();
  const linked = join(root, 'linked');
  const target = join(root, 'target');
  mkdirSync(target);
  symlinkSync(target, linked);

  await assert.rejects(
    ingestor.verifyInstalledObject({ objectDir: missing, digest: 'a'.repeat(64) as never }),
    /path does not exist/,
  );
  await assert.rejects(
    ingestor.verifyInstalledObject({ objectDir: linked, digest: 'a'.repeat(64) as never }),
    /path is a symlink/,
  );
  const file = join(root, 'file');
  writeFileSync(file, 'not a directory');
  await assert.rejects(
    ingestor.verifyInstalledObject({ objectDir: file, digest: 'a'.repeat(64) as never }),
    /path is not a directory/,
  );
  assert.equal(existsSync(target), true);
});
