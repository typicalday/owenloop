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
  // is exactly <config>/owenloop for both XDG_CONFIG_HOME and HOME fallback.
  return dirname(allowedSignersPath(env));
}

/** `<config>/owenloop/org-root.pub`, the public local trust anchor. */
export function orgRootPublicKeyPath(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'org-root.pub');
}

/** `<config>/owenloop/org-root`, the private anchor path. */
export function orgRootPrivateKeyPath(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'org-root');
}

/** `<config>/owenloop/roster`, containing enrollment-grant envelopes. */
export function rosterDir(env: Record<string, string | undefined>): string {
  return join(orgRootDir(env), 'roster');
}

/** `<config>/owenloop/revocations`, containing revocation envelopes. */
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

/** Load sorted `.grant.dsse` bytes from the injected roster directory. */
export function loadRoster(env: Record<string, string | undefined>): Uint8Array[] {
  return loadEnvelopeDirectory(rosterDir(env), '.grant.dsse', 'roster');
}

/** Load sorted `.revocation.dsse` bytes from the injected revocation directory. */
export function loadRevocations(env: Record<string, string | undefined>): Uint8Array[] {
  return loadEnvelopeDirectory(revocationsDir(env), '.revocation.dsse', 'revocations');
}
