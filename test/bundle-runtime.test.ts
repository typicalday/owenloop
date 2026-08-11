import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  archivePathViolation,
  canonicalBundlePathViolation,
  DEFAULT_TAR_LIMITS,
  parseTar,
} from '../src/archive.ts';
import {
  BundleError,
  digestBundle,
  inspectBundle,
  packBundle,
  unpackBundle,
} from '../src/bundle/index.ts';
import { manifestToBytes, parseManifestBytes } from '../src/bundle/manifest.ts';
import { packageVersion } from '../src/package-version.ts';
import {
  SUPPORTED_RUNTIME_FEATURES,
  evaluateRuntimeCompatibility,
} from '../src/bundle/runtime.ts';
import { buildCanonicalTar, gzipDeterministic } from '../src/bundle/tar.ts';
import type { BundleManifest, BundleRuntimeRequirements } from '../src/bundle/types.ts';
import { hostileFileEntry, hostileTarball } from './helpers.ts';
import {
  createBundleIngestor,
  installWorkflowBundle,
  objectDirForDigest,
  storeIndexPath,
  workflowStoreStatePaths,
} from '../src/store/index.ts';

const ROOT = join(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'test', 'fixtures', 'bundle', 'golden-source');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'bundle', 'golden.wnlp');
const GOLDEN_JSON = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'bundle', 'golden.json'), 'utf8')) as {
  digest: string;
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'owenloop-runtime-'));
}

function nextPatchVersion(version: string): string {
  const core = version.split('+', 1)[0]!.split('-', 1)[0]!;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
  assert.ok(match !== null, `package version must be canonical SemVer, got ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function errorFrom(fn: () => unknown): BundleError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BundleError, `expected BundleError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected operation to throw');
}

function manifestText(runtimeYaml?: string): string {
  return [
    'formatVersion: 2',
    'package:',
    '  name: fixture',
    '  version: "1.0.0"',
    ...(runtimeYaml === undefined ? [] : ['runtime:', ...runtimeYaml.split('\n').map((line) => `  ${line}`)]),
    'workflows:',
    '  fixture: "workflow.yaml"',
    'platforms: []',
    'integrity:',
    '  algorithm: sha256',
    '  files: {}',
    'capabilities: {}',
    'lock: {}',
    '',
  ].join('\n');
}

function parseRuntime(runtimeYaml: string): BundleManifest {
  return parseManifestBytes(Buffer.from(manifestText(runtimeYaml)));
}

function archiveWithRuntime(runtime: BundleRuntimeRequirements): Buffer {
  const tarEntries = parseTar(gunzipSync(readFileSync(GOLDEN)), DEFAULT_TAR_LIMITS, { policy: 'strict' });
  const manifestEntry = tarEntries.find((entry) => entry.path === 'bundle.yaml');
  assert.ok(manifestEntry !== undefined);
  const manifest = parseManifestBytes(manifestEntry.data);
  const files = tarEntries.map((entry) => ({
    path: entry.path,
    bytes: entry.path === 'bundle.yaml'
      ? manifestToBytes({ ...manifest, runtime })
      : entry.data,
    mode: entry.mode,
  }));
  return gzipDeterministic(buildCanonicalTar(files));
}

async function assertAdmissionRejectedBeforeWrites(bytes: Uint8Array, code: BundleError['code']): Promise<void> {
  const inspectError = errorFrom(() => inspectBundle(bytes));
  assert.equal(inspectError.code, code);

  const unpackRoot = tempDir();
  const destination = join(unpackRoot, 'out');
  const unpackError = errorFrom(() => unpackBundle(bytes, destination));
  assert.equal(unpackError.code, code);
  assert.equal(existsSync(destination), false);

  const root = tempDir();
  const state = workflowStoreStatePaths(root);
  await assert.rejects(
    installWorkflowBundle({
      bytes,
      source: { kind: 'file', path: join(root, 'invalid.wnlp') },
      root,
      level: 'project',
      lockPath: state.lockPath,
      journalPath: state.journalPath,
      recoveryMarkerDir: tempDir(),
      ingestor: createBundleIngestor(),
      verifier: { verify: async (): Promise<void> => {} },
    }),
    (error: unknown) => error instanceof BundleError && error.code === code,
  );
  assert.equal(existsSync(join(root, 'objects')), false);
  assert.equal(existsSync(storeIndexPath(root)), false);
  assert.equal(existsSync(state.journalPath), false);
}

test('runtime absence preserves the existing canonical manifest bytes and golden bundle digest', () => {
  const sourceManifest = readFileSync(join(SOURCE, 'bundle.yaml'));
  const parsed = parseManifestBytes(sourceManifest);
  assert.equal(parsed.runtime, undefined);

  const packed = packBundle(SOURCE);
  assert.equal(packed.manifest.runtime, undefined);
  assert.equal(packed.digest, GOLDEN_JSON.digest);
  assert.deepEqual(Buffer.from(packed.bytes), readFileSync(GOLDEN));
});

test('canonical bundle admission rejects complete-segment file-prefix collisions before writes', async () => {
  assert.throws(
    () => buildCanonicalTar([
      { path: 'a', bytes: Buffer.from('root'), mode: 0o644 },
      { path: 'a-', bytes: Buffer.from('intervening'), mode: 0o644 },
      { path: 'a/b', bytes: Buffer.from('child'), mode: 0o644 },
    ]),
    (error: unknown) => error instanceof BundleError && error.code === 'ARCHIVE_PATH_PREFIX_COLLISION',
  );

  const bytes = hostileTarball([
    ...hostileFileEntry('a', 'root'),
    ...hostileFileEntry('a-', 'intervening'),
    ...hostileFileEntry('a/b', 'child'),
  ]);
  await assertAdmissionRejectedBeforeWrites(bytes, 'ARCHIVE_PATH_PREFIX_COLLISION');
});

test('canonical bundle paths reject backslashes while GitHub archive compatibility remains separate', async () => {
  assert.equal(archivePathViolation('windows\\path.txt'), undefined);
  assert.match(canonicalBundlePathViolation('windows\\path.txt') ?? '', /backslash/);
  assert.throws(
    () => buildCanonicalTar([
      { path: 'windows\\path.txt', bytes: Buffer.from('x'), mode: 0o644 },
    ]),
    (error: unknown) => error instanceof BundleError && error.code === 'SOURCE_INVALID_PATH',
  );

  const bytes = hostileTarball(hostileFileEntry('windows\\path.txt', 'x'));
  await assertAdmissionRejectedBeforeWrites(bytes, 'ARCHIVE_PATH_VIOLATION');
});

test('POSIX source packing rejects a literal backslash filename', { skip: process.platform === 'win32' }, () => {
  const source = tempDir();
  cpSync(SOURCE, source, { recursive: true });
  writeFileSync(join(source, 'windows\\path.txt'), 'x');
  const error = errorFrom(() => packBundle(source));
  assert.equal(error.code, 'SOURCE_INVALID_PATH');
  assert.match(error.message, /backslash/);
});

test('runtime minimum-version-only declarations accept the running version and reject a strictly higher minimum', () => {
  const running = packageVersion();
  const higher = nextPatchVersion(running);
  assert.deepEqual(parseRuntime(`minVersion: "${running}"`).runtime, { minVersion: running });

  const error = errorFrom(() => parseRuntime(`minVersion: "${higher}"`));
  assert.equal(error.code, 'RUNTIME_INCOMPATIBLE');
  assert.ok(error.message.includes(`requires Owenloop >= ${higher}`));
  assert.ok(error.message.includes(`running version is ${running}`));
  assert.match(error.message, /install or upgrade Owenloop/);
});

test('runtime feature-only declarations accept advertised features, including with unavailable version', () => {
  const feature = SUPPORTED_RUNTIME_FEATURES[0];
  assert.deepEqual(parseRuntime(`features:\n  - "${feature}"`).runtime, { features: [feature] });

  const result = evaluateRuntimeCompatibility(
    { features: [feature] },
    { version: '0.0.0', features: new Set([feature]) },
  );
  assert.equal(result.compatible, true);
  assert.equal(result.versionSatisfied, true);
});

test('runtime minVersion and features use AND semantics', () => {
  const requirements = {
    minVersion: '0.5.0',
    features: [...SUPPORTED_RUNTIME_FEATURES],
  };
  const parsed = parseRuntime([
    'minVersion: "0.5.0"',
    'features:',
    ...[...SUPPORTED_RUNTIME_FEATURES].reverse().map((feature) => `  - "${feature}"`),
  ].join('\n')).runtime;
  assert.equal(parsed?.minVersion, requirements.minVersion);
  assert.deepEqual(new Set(parsed?.features), new Set(requirements.features));

  const missingFeature = evaluateRuntimeCompatibility(requirements, {
    version: '0.5.0',
    features: new Set([SUPPORTED_RUNTIME_FEATURES[0]]),
  });
  assert.equal(missingFeature.versionSatisfied, true);
  assert.equal(missingFeature.compatible, false);
  assert.deepEqual(missingFeature.unsupportedFeatures, [SUPPORTED_RUNTIME_FEATURES[1]]);

  const lowVersion = evaluateRuntimeCompatibility(requirements, {
    version: '0.4.9',
    features: new Set(SUPPORTED_RUNTIME_FEATURES),
  });
  assert.equal(lowVersion.unsupportedFeatures.length, 0);
  assert.equal(lowVersion.compatible, false);
});

test('runtime shape and member type errors use MANIFEST_ERROR', () => {
  const cases = [
    ['[]', /must be a mapping/],
    ['"text"', /must be a mapping/],
    ['{}', /must declare minVersion, features, or both/],
    ['unknown: true', /unknown key 'unknown'/],
    ['minVersion: 1', /minVersion: must be a string/],
    ['features: "feature.v1"', /features: must be a list/],
    ['features:\n  - 1', /features\[0\]: must be a string/],
    ['features: []', /must contain at least one feature/],
    ['features:\n  - "known.v1"\n  - "known.v1"', /duplicate value 'known\.v1'/],
  ] as const;
  for (const [runtimeYaml, message] of cases) {
    const error = errorFrom(() => parseRuntime(runtimeYaml));
    assert.equal(error.code, 'MANIFEST_ERROR', runtimeYaml);
    assert.match(error.message, message, runtimeYaml);
  }
});

test('runtime features require portable lowercase versioned identifiers', () => {
  for (const feature of ['feature', 'feature.v0', 'Feature.v1', '.v1', 'feature v1', 'feature.v01', 'feature..part.v1']) {
    const error = errorFrom(() => parseRuntime(`features:\n  - "${feature}"`));
    assert.equal(error.code, 'MANIFEST_ERROR', feature);
    assert.match(error.message, /versioned identifier/, feature);
  }
});

test('runtime minVersion rejects ranges, prefixes, whitespace, and non-canonical SemVer', () => {
  for (const version of ['^0.5.0', '>=0.5.0', 'v0.5.0', '=0.5.0', ' 0.5.0', '0.5.0 ', '01.2.3', '1.2', '1.2.3-']) {
    const error = errorFrom(() => parseRuntime(`minVersion: "${version}"`));
    assert.equal(error.code, 'MANIFEST_ERROR', version);
    assert.match(error.message, /canonical strict SemVer/, version);
  }
});

test('runtime evaluator follows SemVer prerelease and build precedence', () => {
  const features = new Set<string>();
  assert.equal(evaluateRuntimeCompatibility(
    { minVersion: '1.2.3-rc.1' },
    { version: '1.2.3-rc.2', features },
  ).compatible, true);
  assert.equal(evaluateRuntimeCompatibility(
    { minVersion: '1.2.3' },
    { version: '1.2.3-rc.9', features },
  ).compatible, false);
  assert.equal(evaluateRuntimeCompatibility(
    { minVersion: '1.2.3+required-build' },
    { version: '1.2.3+other-build', features },
  ).compatible, true);
});

test('runtime incompatibility diagnostics name unsupported features and low or unavailable versions', () => {
  const unsupported = evaluateRuntimeCompatibility(
    { features: ['zeta.v1', 'alpha.v1'] },
    { version: '9.0.0', features: new Set() },
  );
  assert.deepEqual(unsupported.unsupportedFeatures, ['alpha.v1', 'zeta.v1']);
  assert.match(unsupported.diagnostics[0]!, /alpha\.v1, zeta\.v1/);
  assert.match(unsupported.diagnostics[0]!, /install or upgrade Owenloop/);

  const unavailable = evaluateRuntimeCompatibility(
    { minVersion: '0.0.0' },
    { version: '0.0.0', features: new Set() },
  );
  assert.equal(unavailable.compatible, false, 'the production sentinel fails every minVersion requirement');
  assert.match(unavailable.diagnostics[0]!, /version is unavailable \(0\.0\.0\)/);
  assert.match(unavailable.diagnostics[0]!, /install or upgrade Owenloop/);
});

test('runtime serialization uses fixed field order and UTF-8 byte-sorted feature order', () => {
  const manifest = parseRuntime([
    'features:',
    `  - "${SUPPORTED_RUNTIME_FEATURES[1]}"`,
    `  - "${SUPPORTED_RUNTIME_FEATURES[0]}"`,
    'minVersion: "0.5.0"',
  ].join('\n'));
  const serialized = Buffer.from(manifestToBytes(manifest)).toString('utf8');
  assert.ok(serialized.indexOf('package:') < serialized.indexOf('runtime:'));
  assert.ok(serialized.indexOf('runtime:') < serialized.indexOf('workflows:'));
  assert.ok(serialized.indexOf('minVersion:') < serialized.indexOf('features:'));
  assert.ok(serialized.indexOf(SUPPORTED_RUNTIME_FEATURES[0]) < serialized.indexOf(SUPPORTED_RUNTIME_FEATURES[1]));
});

test('incompatible source packing fails before workflow definition loading', () => {
  const source = tempDir();
  cpSync(SOURCE, source, { recursive: true });
  const manifestPath = join(source, 'bundle.yaml');
  const manifest = readFileSync(manifestPath, 'utf8').replace(
    'workflows:',
    'runtime:\n  minVersion: "999.0.0"\nworkflows:',
  );
  writeFileSync(manifestPath, manifest);
  writeFileSync(join(source, 'workflows', 'golden.yaml'), 'not: [valid workflow');

  const error = errorFrom(() => packBundle(source));
  assert.equal(error.code, 'RUNTIME_INCOMPATIBLE');
});

test('inspect and unpack reject incompatible archives before exposing or writing definitions', () => {
  const bytes = archiveWithRuntime({ minVersion: '999.0.0' });
  const inspectError = errorFrom(() => inspectBundle(bytes));
  assert.equal(inspectError.code, 'RUNTIME_INCOMPATIBLE');

  const destination = join(tempDir(), 'out');
  const unpackError = errorFrom(() => unpackBundle(bytes, destination));
  assert.equal(unpackError.code, 'RUNTIME_INCOMPATIBLE');
  assert.equal(existsSync(destination), false);
});

test('workflow-store installation rejects incompatible bytes before object or index commit', async () => {
  const bytes = archiveWithRuntime({ minVersion: '999.0.0' });
  const digest = digestBundle(bytes).digest;
  const root = tempDir();
  const state = workflowStoreStatePaths(root);

  await assert.rejects(
    installWorkflowBundle({
      bytes,
      source: { kind: 'file', path: join(root, 'incompatible.wnlp') },
      root,
      level: 'project',
      lockPath: state.lockPath,
      journalPath: state.journalPath,
      recoveryMarkerDir: tempDir(),
      ingestor: createBundleIngestor(),
      verifier: { verify: async (): Promise<void> => {} },
    }),
    (error: unknown) => error instanceof BundleError && error.code === 'RUNTIME_INCOMPATIBLE',
  );
  assert.equal(existsSync(objectDirForDigest(root, digest as never)), false);
  assert.equal(existsSync(storeIndexPath(root)), false);
});

test('digestBundle remains identity-only and accepts incompatible bundle bytes', () => {
  const bytes = archiveWithRuntime({ minVersion: '999.0.0' });
  assert.equal(digestBundle(bytes).digest.length, 64);
  assert.equal(errorFrom(() => inspectBundle(bytes)).code, 'RUNTIME_INCOMPATIBLE');
});
