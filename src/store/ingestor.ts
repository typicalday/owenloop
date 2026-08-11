/**
 * Concrete `.wnlp` bundle ingestion and on-read object verification.
 *
 * The bundle format owns archive validation and the canonical content digest;
 * this adapter connects that byte-oriented API to the workflow store's staged
 * object contract. Installed objects are verified from their manifest integrity
 * map every time instruction content is resolved.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalBundlePathViolation } from '../archive.ts';
import { unpackBundle } from '../bundle/index.ts';
import { parseManifestBytes, sha256Hex } from '../bundle/manifest.ts';
import { buildCanonicalTar, compareUtf8Paths } from '../bundle/tar.ts';
import type { BundleManifest } from '../bundle/types.ts';
import { StorePathError, workflowCoordinate } from './types.ts';
import type { WorkflowCoordinate } from './types.ts';
import type { BundleIngestor, BundleSource } from './install.ts';
import type { DefDigest } from './types.ts';
import { coordinateDigestReadSync } from './resolve.ts';

export interface BundleIngestorOptions {
  /** Explicit namespace override for the package-derived store coordinate. */
  namespace?: string;
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function refuse(path: string, detail: string): never {
  throw new StorePathError(`refusing workflow object '${path}': ${detail}`);
}

function assertDirectory(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) refuse(path, 'path does not exist');
  if (st.isSymbolicLink()) refuse(path, 'path is a symlink');
  if (!st.isDirectory()) refuse(path, 'path is not a directory');
}

function coordinateFor(manifest: BundleManifest, namespace: string): WorkflowCoordinate {
  return workflowCoordinate({
    namespace,
    name: manifest.package.name,
    version: manifest.package.version,
  });
}

/**
 * Re-check one unpacked object against its strict package manifest.
 * `bundle.yaml` is intentionally absent from `integrity.files` because its
 * content participates in the canonical bundle digest and self-hashing would
 * be recursive.
 *
 * SYNCHRONOUS by construction: every filesystem call in the body is a `*Sync`
 * call, and it awaits nothing. The `BundleIngestor.verifyInstalledObject` port
 * stays `Promise`-returning (an adapter may legitimately need I/O concurrency),
 * but this default adapter's implementation does not, so WS-6's def loader —
 * which must run inside the synchronous `openCtx`/`dispatch` path — calls this
 * function directly instead of forcing `openCtx` to become `async`. Exported
 * for exactly that caller; the async port remains the public contract.
 */
export interface VerifyWorkflowObjectOptions {
  /** Optional directory-entry source used by tests to control filesystem order. */
  readDir?: (directory: string) => string[];
  /** Optional visit trace used by tests to assert recursive traversal order. */
  onVisit?: (relativePath: string) => void;
  /** False only when an async caller already waited on the matching repair journal. */
  coordinateRepair?: boolean;
  /** False only for staged pre-swap content; installed objects require exact hardened modes. */
  requireHardenedModes?: boolean;
}

function modeString(mode: number): string {
  return `0${(mode & 0o7777).toString(8)}`;
}

function assertHardenedDirectory(path: string, mode: number): void {
  const actual = mode & 0o7777;
  if (actual !== 0o555) {
    refuse(path, `directory mode is ${modeString(actual)}, expected hardened store mode 0555`);
  }
}

function assertHardenedFile(path: string, mode: number): void {
  const actual = mode & 0o7777;
  const expected = (actual & 0o111) === 0 ? 0o444 : 0o555;
  if (actual !== expected) {
    refuse(
      path,
      `regular file mode is ${modeString(actual)}, expected hardened store mode ${modeString(expected)}`,
    );
  }
}

/** Verify exact immutable store modes independently from canonical identity. */
export function verifyHardenedWorkflowObjectModesSync(objectDir: string): void {
  assertDirectory(objectDir);
  const walk = (directory: string): void => {
    const directoryStat = lstatSync(directory);
    assertHardenedDirectory(directory, directoryStat.mode);
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (st === undefined) refuse(full, 'path disappeared during hardened-mode verification');
      if (st.isSymbolicLink()) refuse(full, 'object contains a symlink');
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) assertHardenedFile(full, st.mode);
      else refuse(full, 'object contains a non-regular filesystem node');
    }
  };
  walk(objectDir);
}

function verifyWorkflowObjectOnce(
  objectDir: string,
  digest: DefDigest,
  options: VerifyWorkflowObjectOptions,
): void {
  assertDirectory(objectDir);
  const requireHardenedModes = options.requireHardenedModes !== false;
  const readDir = options.readDir ?? ((directory: string) => readdirSync(directory));

  const manifestPath = join(objectDir, 'bundle.yaml');
  const manifestStat = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (manifestStat === undefined) refuse(manifestPath, `missing manifest for digest ${digest}`);
  if (manifestStat.isSymbolicLink()) refuse(manifestPath, 'manifest is a symlink');
  if (!manifestStat.isFile()) refuse(manifestPath, 'manifest is not a regular file');

  let manifest: BundleManifest;
  try {
    manifest = parseManifestBytes(readFileSync(manifestPath));
  } catch (error) {
    refuse(manifestPath, `invalid bundle.yaml for digest ${digest}: ${(error as Error).message}`);
  }

  const actual = new Map<string, { bytes: Buffer; sha256: string; mode: 0o644 | 0o755 }>();
  const walk = (directory: string): void => {
    const entries = readDir(directory);
    for (const entry of entries) {
      const full = join(directory, entry);
      const rel = posixRelative(objectDir, full);
			options.onVisit?.(rel);
      const violation = canonicalBundlePathViolation(rel);
      if (violation !== undefined) refuse(full, `unsafe installed path '${rel}': ${violation}`);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (st === undefined) refuse(full, 'path disappeared during verification');
      if (st.isSymbolicLink()) refuse(full, 'object contains a symlink');
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        try {
					const bytes = readFileSync(full);
					actual.set(rel, {
						bytes,
						sha256: sha256Hex(bytes),
						mode: (st.mode & 0o111) === 0 ? 0o644 : 0o755,
					});
        } catch (error) {
          refuse(full, `could not read regular file: ${(error as Error).message}`);
        }
      } else {
        refuse(full, 'object contains a non-regular filesystem node');
      }
    }
  };
  walk(objectDir);

  for (const [path, expected] of Object.entries(manifest.integrity.files)) {
    const found = actual.get(path);
    if (found === undefined) {
      refuse(join(objectDir, path), `integrity map lists missing file '${path}' for digest ${digest}`);
    }
    if (found.sha256 !== expected) {
      refuse(join(objectDir, path), `integrity mismatch for '${path}' (expected ${expected}, got ${found.sha256})`);
    }
  }

  for (const [path] of actual) {
    if (path === 'bundle.yaml') continue;
    if (!Object.prototype.hasOwnProperty.call(manifest.integrity.files, path)) {
      refuse(join(objectDir, path), `file '${path}' is not listed in bundle.yaml integrity.files`);
    }
  }

  let canonicalTar: Buffer;
  try {
		const canonicalFiles = [...actual.entries()]
			.map(([path, file]) => ({ path, bytes: file.bytes, mode: file.mode }))
			.sort((a, b) => compareUtf8Paths(a.path, b.path));
		canonicalTar = buildCanonicalTar(canonicalFiles);
  } catch (error) {
    refuse(objectDir, `could not reconstruct canonical bundle bytes: ${(error as Error).message}`);
  }
  const actualDigest = sha256Hex(canonicalTar);
  if (actualDigest !== digest) {
    refuse(
      objectDir,
      `canonical bundle digest mismatch (expected content-addressed digest ${digest}, got ${actualDigest})`,
    );
  }
  if (requireHardenedModes) verifyHardenedWorkflowObjectModesSync(objectDir);
}

export function verifyWorkflowObjectSync(
  objectDir: string,
  digest: DefDigest,
  options: VerifyWorkflowObjectOptions = {},
): void {
  const resolvedObjectDir = resolve(objectDir);
  const storeRoot = dirname(dirname(dirname(resolvedObjectDir)));
  const isDigestPath = resolvedObjectDir === join(storeRoot, 'objects', 'sha256', digest);
  const verify = (): void => verifyWorkflowObjectOnce(objectDir, digest, options);
  if (options.coordinateRepair === false || !isDigestPath) {
    verify();
    return;
  }
  coordinateDigestReadSync(storeRoot, digest, verify);
}

/** Create the real store adapter used by the default CLI and driver paths. */
export function createBundleIngestor(options: BundleIngestorOptions = {}): BundleIngestor {
  const namespaceOverride = options.namespace;
  if (namespaceOverride !== undefined && namespaceOverride.trim() === '') {
    throw new StorePathError('bundle ingestor namespace must not be empty');
  }

  return {
    async ingest(input: { source: BundleSource; bytes: Uint8Array; stagingDir: string }): Promise<{
      coordinate: WorkflowCoordinate;
      digest: DefDigest;
      workflows: string[];
    }> {
      // installWorkflowBundle removes the complete staging root immediately
      // before this call. unpackBundle requires an existing, real parent and a
      // destination that does not exist, so create only the parent here.
      mkdirSync(dirname(input.stagingDir), { recursive: true });
      const result = unpackBundle(input.bytes, input.stagingDir);
      const namespace = namespaceOverride ?? result.manifest.package.name;
      return {
        coordinate: coordinateFor(result.manifest, namespace),
        digest: result.digest as DefDigest,
        workflows: Object.keys(result.manifest.workflows).sort(),
      };
    },

    async verifyInstalledObject(input: { objectDir: string; digest: DefDigest }): Promise<void> {
      verifyWorkflowObjectSync(input.objectDir, input.digest);
    },

    async verifyStagedObject(input: { objectDir: string; digest: DefDigest }): Promise<void> {
      verifyWorkflowObjectSync(input.objectDir, input.digest, {
	coordinateRepair: false,
	requireHardenedModes: false,
      });
    },

    async verifyInstalledObjectAfterCoordination(
      input: { objectDir: string; digest: DefDigest },
    ): Promise<void> {
      verifyWorkflowObjectSync(input.objectDir, input.digest, { coordinateRepair: false });
    },
  };
}

