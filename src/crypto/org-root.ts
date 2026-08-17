/**
 * Local filesystem paths and loaders for an organization's enrollment anchor.
 *
 * The module derives every path from an injected environment, with
 * XDG_CONFIG_HOME taking precedence over HOME. The loader only returns raw
 * envelope bytes; chain.ts remains a pure verifier and does not know this
 * layout. This module deliberately does not transport registrations, contact a
 * hub, or expose private key bytes.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allowedSignersPath } from './trust-roots.ts';

export interface OrgRootPresent {
  kind: 'present';
  path: string;
  publicKey: string;
}

export interface OrgRootAbsent {
  kind: 'absent';
  path: string;
}

export type OrgRootResolution = OrgRootPresent | OrgRootAbsent;

function orgRootDir(env: Record<string, string | undefined>): string {
  // allowedSignersPath is the established injected-env resolver. Its dirname
  // is exactly <config>.
  return dirname(allowedSignersPath(env));
}

/** `<config>/org-root.pub`, the public local trust anchor. */
export function orgRootPublicKeyPath(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'org-root.pub');
}

/** `<config>/org-root`, the private anchor path. */
export function orgRootPrivateKeyPath(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'org-root');
}

/** `<config>/grants`, containing enrollment-grant envelopes. */
export function grantsDir(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'grants');
}

/** The pre-rename grants directory. Probed only to refuse; never read. */
function legacyGrantsDir(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'roster');
}

/**
 * Count entries named `*.grant.dsse`, by name only, never throwing.
 *
 * This is a diagnostic hint, not a resolution target. Counting by name
 * regardless of entry type ensures even a symlinked legacy entry signals that
 * the operator has grants that require an explicit migration.
 */
function countGrantFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.grant.dsse')).length;
  } catch {
    return 0;
  }
}

/** Thrown when grants exist only under the pre-rename directory. */
export class StrandedLegacyGrantsError extends Error {
  override readonly name = 'StrandedLegacyGrantsError';
  readonly grantsPath: string;
  readonly legacyPath: string;
  readonly legacyCount: number;

  constructor(grantsPath: string, legacyPath: string, legacyCount: number) {
    super(
      `enrollment grants are stranded in the pre-rename directory: '${grantsPath}' holds no *.grant.dsse files, ` +
      `but '${legacyPath}' holds ${legacyCount}. owenloop reads only '${grantsPath}' and will not move your ` +
      `cryptographic material for you. Run:  mv '${legacyPath}' '${grantsPath}'  ` +
      'then restart every running owenloop shift daemon.',
    );
    this.grantsPath = grantsPath;
    this.legacyPath = legacyPath;
    this.legacyCount = legacyCount;
  }
}

/** Refuse when the new grants directory is empty and the old one is not. */
export function assertNoStrandedLegacyGrants(env: Record<string, string | undefined>): void {
  const grants = grantsDir(env);
  if (countGrantFiles(grants) > 0) return;
  const legacy = legacyGrantsDir(env);
  const count = countGrantFiles(legacy);
  if (count > 0) throw new StrandedLegacyGrantsError(grants, legacy, count);
}

/** `<config>/revocations`, containing revocation envelopes. */
export function revocationsDir(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'revocations');
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} path is a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`${label} path is not a regular file: ${path}`);
}

/** Resolve the public anchor without treating absence as a local-store error. */
export function resolveOrgRoot(env: Record<string, string | undefined>): OrgRootResolution {
  const path = orgRootPublicKeyPath(env);
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return { kind: 'absent', path };
  assertRegularFile(path, 'org-root public key');
  return { kind: 'present', path, publicKey: readFileSync(path, 'utf8') };
}

function loadEnvelopeDirectory(path: string, suffix: string, label: string): Uint8Array[] {
  const dirStat = lstatSync(path, { throwIfNoEntry: false });
  if (dirStat === undefined) return [];
  if (dirStat.isSymbolicLink()) throw new Error(`${label} directory is a symlink: ${path}`);
  if (!dirStat.isDirectory()) throw new Error(`${label} path is not a directory: ${path}`);

  const entries = readdirSync(path).sort();
  const result: Uint8Array[] = [];
  for (const name of entries) {
    const entryPath = join(path, name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) throw new Error(`${label} entry is a symlink: ${entryPath}`);
    if (!stat.isFile()) throw new Error(`${label} entry is not a regular file: ${entryPath}`);
    if (name.endsWith(suffix)) result.push(readFileSync(entryPath));
  }
  return result;
}

/** Load sorted `.grant.dsse` bytes from the injected grants directory. */
export function loadGrants(env: Record<string, string | undefined>): Uint8Array[] {
  const grants = loadEnvelopeDirectory(grantsDir(env), '.grant.dsse', 'grants');
  if (grants.length === 0) assertNoStrandedLegacyGrants(env);
  return grants;
}

/** Load sorted `.revocation.dsse` bytes from the injected revocation directory. */
export function loadRevocations(env: Record<string, string | undefined>): Uint8Array[] {
  return loadEnvelopeDirectory(revocationsDir(env), '.revocation.dsse', 'revocations');
}
