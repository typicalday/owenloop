/**
 * Resolution of the local SSHSIG trust root used for workflow publications.
 *
 * The path is derived only from injected environment state, through the shared
 * `owenloopConfigDir` ladder (`OWENLOOP_CONFIG_DIR` > `XDG_CONFIG_HOME` >
 * `HOME`); no ambient home directory lookup is allowed here. An absent file is
 * a normal result so the
 * publication verifier can classify it as `unverifiable` instead of confusing
 * a missing trust root with an unsigned bundle.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { owenloopConfigFile } from '../config-dir.ts';

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

/**
 * Resolve `<owenloop config dir>/allowed_signers` from caller-supplied env,
 * through the one shared ladder in `../config-dir.ts`.
 */
export function allowedSignersPath(env: Record<string, string | undefined>): string {
  try {
    return owenloopConfigFile(env, 'allowed_signers');
  } catch (err) {
    // Keep this resolver's own subject in the message. The shared ladder names
    // the VARIABLES; this prefix names WHICH path could not be located, which
    // is what the publication verifier reports to the operator.
    throw new Error(`cannot locate an allowed_signers path: ${err instanceof Error ? err.message : String(err)}`);
  }
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
