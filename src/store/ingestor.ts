/**
 * Concrete `.wnlp` bundle ingestion and on-read object verification.
 *
 * The bundle format owns archive validation and the canonical content digest;
 * this adapter connects that byte-oriented API to the workflow store's staged
 * object contract. Installed objects are verified from their manifest integrity
 * map every time instruction content is resolved.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { unpackBundle } from '../bundle/index.ts';
import { parseManifestBytes, sha256Hex } from '../bundle/manifest.ts';
import type { BundleManifest } from '../bundle/types.ts';
import { StorePathError, workflowCoordinate } from './types.ts';
import type { WorkflowCoordinate } from './types.ts';
import type { BundleIngestor, BundleSource } from './install.ts';
import type { DefDigest } from './types.ts';

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
export function verifyWorkflowObjectSync(objectDir: string, digest: DefDigest): void {
  assertDirectory(objectDir);

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

  const actual = new Map<string, string>();
  const walk = (directory: string): void => {
    const entries = readdirSync(directory);
    for (const entry of entries) {
      const full = join(directory, entry);
      const rel = posixRelative(objectDir, full);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (st === undefined) refuse(full, 'path disappeared during verification');
      if (st.isSymbolicLink()) refuse(full, 'object contains a symlink');
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        try {
          actual.set(rel, sha256Hex(readFileSync(full)));
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
    if (found !== expected) {
      refuse(join(objectDir, path), `integrity mismatch for '${path}' (expected ${expected}, got ${found})`);
    }
  }

  for (const [path] of actual) {
    if (path === 'bundle.yaml') continue;
    if (!Object.prototype.hasOwnProperty.call(manifest.integrity.files, path)) {
      refuse(join(objectDir, path), `file '${path}' is not listed in bundle.yaml integrity.files`);
    }
  }
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
  };
}

