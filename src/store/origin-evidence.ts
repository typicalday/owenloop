/**
 * Retention of signed workflow-origin sidecars in the content-addressed store.
 *
 * Origin evidence is mutable store state, not immutable bundle content. The
 * exact sidecar bytes are retained under `<root>/.owenloop/origins/` so
 * execution can verify the statement again against current trust roots.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { defDigest } from './types.ts';
import type { DefDigest } from './types.ts';

function ensureDirectory(path: string): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`origin evidence directory is not a real directory: ${path}`);
    }
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function storeRootFromStaging(objectDir: string): string {
  return dirname(dirname(objectDir));
}

function storeRootFromObject(objectPath: string): string {
  return dirname(dirname(dirname(objectPath)));
}

/** Return the canonical on-disk path for one bundle's retained origin bytes. */
export function originEvidencePath(root: string, digest: string): string {
  return join(root, '.owenloop', 'origins', `${digest}.dsse`);
}

/**
 * Retain exact origin sidecar bytes outside the immutable object. A later
 * unsigned dedupe does not call this function, so existing evidence remains.
 */
export function persistOriginEvidence(objectDir: string, digest: DefDigest, dsseBytes: Uint8Array): void {
  const root = storeRootFromStaging(objectDir);
  const stateDir = join(root, '.owenloop');
  const evidenceDir = join(stateDir, 'origins');
  ensureDirectory(stateDir);
  ensureDirectory(evidenceDir);
  const target = originEvidencePath(root, digest);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(temporary, dsseBytes, { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Read retained origin bytes for an installed object. Missing evidence returns
 * `undefined`; a symlink, wrong file type, or read failure throws so callers
 * can report an unverifiable or invalid execution-time verdict.
 */
export function readOriginEvidence(objectPath: string, digest: string): Uint8Array | undefined {
  const validated = defDigest(digest);
  const target = originEvidencePath(storeRootFromObject(objectPath), validated);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`stored origin evidence is not a regular file: ${target}`);
  }
  return readFileSync(target);
}
