/**
 * Local filesystem paths and loaders for an organization's enrollment anchor.
 *
 * The module derives every path from an injected environment: an absolute
 * OWENLOOP_CONFIG_DIR wins, otherwise paths live below $HOME/.owenloop;
 * XDG_CONFIG_HOME is ignored. The loader only returns raw envelope bytes;
 * chain.ts remains a pure verifier and does not know this layout. This module
 * deliberately does not transport registrations, contact a hub, or expose
 * private key bytes.
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

/** The pre-rename grants directory. Inspected only to refuse; never read. */
function legacyGrantsDir(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'roster');
}

/** Count entries named `*.grant.dsse` without making the new path a loader. */
function countGrantFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.grant.dsse')).length;
  } catch {
    return 0;
  }
}

interface GrantsDirectoryProblem {
  path: string;
  reason: string;
}

interface LegacyGrantsInspection {
  grantCount: number;
  problem: GrantsDirectoryProblem | undefined;
}

function inspectionError(path: string, action: string, error: unknown): GrantsDirectoryProblem {
  return {
    path,
    reason: `${action}: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/** Encode one arbitrary path as a POSIX shell argument. */
function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Inspect the legacy source without reading envelopes. A migration command is
 * safe only when its source has the regular-file structure the old loader
 * accepted; otherwise an operator must repair it by hand.
 */
function inspectLegacyGrantsSource(path: string): LegacyGrantsInspection {
  let stat;
  try {
    stat = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    return { grantCount: 0, problem: inspectionError(path, 'cannot inspect legacy grants source', error) };
  }
  if (stat === undefined) return { grantCount: 0, problem: undefined };
  if (stat.isSymbolicLink()) {
    return { grantCount: 0, problem: { path, reason: 'legacy grants source is a symlink' } };
  }
  if (!stat.isDirectory()) {
    return { grantCount: 0, problem: { path, reason: 'legacy grants source is not a directory' } };
  }

  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    return { grantCount: 0, problem: inspectionError(path, 'cannot inspect legacy grants source', error) };
  }

  let grantCount = 0;
  for (const name of entries) {
    const entryPath = join(path, name);
    let entry;
    try {
      entry = lstatSync(entryPath);
    } catch (error) {
      return { grantCount: 0, problem: inspectionError(entryPath, 'cannot inspect legacy grants source entry', error) };
    }
    if (entry.isSymbolicLink()) {
      return { grantCount: 0, problem: { path: entryPath, reason: 'legacy grants source entry is a symlink' } };
    }
    if (!entry.isFile()) {
      return { grantCount: 0, problem: { path: entryPath, reason: 'legacy grants source entry is not a regular file' } };
    }
    if (name.endsWith('.grant.dsse')) grantCount += 1;
  }
  return { grantCount, problem: undefined };
}

/**
 * A migration command is safe only for an absent destination or a real
 * directory whose entries are all regular files. This never reads envelope
 * bytes; it merely prevents an instruction from silently nesting them.
 */
function inspectGrantsDestination(path: string): GrantsDirectoryProblem | undefined {
  let stat;
  try {
    stat = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    return inspectionError(path, 'cannot inspect grants destination', error);
  }
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink()) return { path, reason: 'grants destination is a symlink' };
  if (!stat.isDirectory()) return { path, reason: 'grants destination is not a directory' };

  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    return inspectionError(path, 'cannot inspect grants destination', error);
  }
  for (const name of entries) {
    const entryPath = join(path, name);
    let entry;
    try {
      entry = lstatSync(entryPath);
    } catch (error) {
      return inspectionError(entryPath, 'cannot inspect grants destination entry', error);
    }
    if (entry.isSymbolicLink()) return { path: entryPath, reason: 'grants destination entry is a symlink' };
    if (!entry.isFile()) return { path: entryPath, reason: 'grants destination entry is not a regular file' };
  }
  return undefined;
}

function sourceManualRepairMessage(
  grantsPath: string,
  legacyPath: string,
  sourceProblem: GrantsDirectoryProblem,
): string {
  return `enrollment grants cannot be safely inspected in the pre-rename directory '${legacyPath}': ` +
    `${sourceProblem.reason}: '${sourceProblem.path}'. '${grantsPath}' holds no *.grant.dsse files. ` +
    'Repair that path by hand before migrating; owenloop will not move your cryptographic material for you.';
}

function migrationMessage(
  grantsPath: string,
  legacyPath: string,
  legacyCount: number,
  quotedGrantsPath: string,
  quotedLegacyPath: string,
): string {
  return `enrollment grants are stranded in the pre-rename directory: '${grantsPath}' holds no *.grant.dsse files, ` +
    `but '${legacyPath}' holds ${legacyCount}. owenloop reads only '${grantsPath}' and will not move your ` +
    `cryptographic material for you. Run:  mkdir -p ${quotedGrantsPath} && mv ${quotedLegacyPath}/*.grant.dsse ${quotedGrantsPath}/  ` +
    'then restart every running owenloop shift daemon.';
}

function destinationManualRepairMessage(
  grantsPath: string,
  legacyPath: string,
  legacyCount: number,
  destinationProblem: GrantsDirectoryProblem,
): string {
  return `enrollment grants are stranded in the pre-rename directory: '${grantsPath}' holds no *.grant.dsse files, ` +
    `but '${legacyPath}' holds ${legacyCount}. The grants destination is unsafe: ${destinationProblem.reason}: ` +
    `'${destinationProblem.path}'. Repair that path by hand before migrating; owenloop will not move your ` +
    'cryptographic material for you.';
}

/** Thrown when legacy grants are stranded or cannot be safely inspected. */
export class StrandedLegacyGrantsError extends Error {
  override readonly name = 'StrandedLegacyGrantsError';
  readonly grantsPath: string;
  readonly legacyPath: string;
  readonly legacyCount: number;
  readonly destinationPath: string | undefined;
  readonly destinationReason: string | undefined;
  readonly sourcePath: string | undefined;
  readonly sourceReason: string | undefined;

  constructor(
    grantsPath: string,
    legacyPath: string,
    legacyCount: number,
    destinationProblem: GrantsDirectoryProblem | undefined,
    sourceProblem: GrantsDirectoryProblem | undefined = undefined,
  ) {
    const quotedGrantsPath = quotePosixShellArgument(grantsPath);
    const quotedLegacyPath = quotePosixShellArgument(legacyPath);
    let message: string;
    if (sourceProblem !== undefined) {
      message = sourceManualRepairMessage(grantsPath, legacyPath, sourceProblem);
    } else if (destinationProblem === undefined) {
      message = migrationMessage(grantsPath, legacyPath, legacyCount, quotedGrantsPath, quotedLegacyPath);
    } else {
      message = destinationManualRepairMessage(grantsPath, legacyPath, legacyCount, destinationProblem);
    }
    super(message);
    this.grantsPath = grantsPath;
    this.legacyPath = legacyPath;
    this.legacyCount = legacyCount;
    this.destinationPath = destinationProblem?.path;
    this.destinationReason = destinationProblem?.reason;
    this.sourcePath = sourceProblem?.path;
    this.sourceReason = sourceProblem?.reason;
  }
}

/** Refuse when legacy grants are stranded or cannot be safely inspected. */
export function assertNoStrandedLegacyGrants(env: Record<string, string | undefined>): void {
  const grants = grantsDir(env);
  if (countGrantFiles(grants) > 0) return;
  const legacy = legacyGrantsDir(env);
  const inspection = inspectLegacyGrantsSource(legacy);
  if (inspection.problem !== undefined) {
    throw new StrandedLegacyGrantsError(
      grants,
      legacy,
      inspection.grantCount,
      inspectGrantsDestination(grants),
      inspection.problem,
    );
  }
  if (inspection.grantCount > 0) {
    throw new StrandedLegacyGrantsError(grants, legacy, inspection.grantCount, inspectGrantsDestination(grants));
  }
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
  assertNoStrandedLegacyGrants(env);
  return loadEnvelopeDirectory(grantsDir(env), '.grant.dsse', 'grants');
}

/** Load sorted `.revocation.dsse` bytes from the injected revocation directory. */
export function loadRevocations(env: Record<string, string | undefined>): Uint8Array[] {
  return loadEnvelopeDirectory(revocationsDir(env), '.revocation.dsse', 'revocations');
}
