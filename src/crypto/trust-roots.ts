/**
 * Resolution of the local SSHSIG trust root used for workflow publications.
 *
 * The path is derived only from injected environment state. XDG_CONFIG_HOME
 * wins over HOME, matching the execution settings path; no ambient home
 * directory lookup is allowed here. An absent file is a normal result so the
 * publication verifier can classify it as `unverifiable` instead of confusing
 * a missing trust root with an unsigned bundle.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AllowedSignersPresent {
  kind: 'present';
  path: string;
  text: string;
}

export interface AllowedSignersAbsent {
  kind: 'absent';
  path: string;
}

export type AllowedSignersResolution = AllowedSignersPresent | AllowedSignersAbsent;

/** Resolve `<config>/owenloop/allowed_signers` from caller-supplied env. */
export function allowedSignersPath(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim() !== '') return join(xdg, 'owenloop', 'allowed_signers');
  const home = env.HOME;
  if (home !== undefined && home.trim() !== '') return join(home, '.config', 'owenloop', 'allowed_signers');
  throw new Error('cannot locate an allowed_signers path: set HOME or XDG_CONFIG_HOME');
}

/**
 * Read the trust root without collapsing absence and malformed contents. A
 * present path must be a regular file; symlinks and read failures are hard
 * errors for the caller to classify as `unverifiable`.
 */
export function resolveAllowedSigners(env: Record<string, string | undefined>): AllowedSignersResolution {
  const path = allowedSignersPath(env);
  if (!existsSync(path)) return { kind: 'absent', path };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`allowed_signers path is a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`allowed_signers path is not a regular file: ${path}`);
  return { kind: 'present', path, text: readFileSync(path, 'utf8') };
}

/** Alias with an explicit file-oriented name for callers that prefer it. */
export const resolveAllowedSignersFile = resolveAllowedSigners;
