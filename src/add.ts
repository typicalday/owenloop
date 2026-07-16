/**
 * Pure helpers for the `owenloop add <owner>/<repo>[@ref]` CLI verb (workflow
 * distribution Stage 1 — see the design doc this implements,
 * `docs/workflow-distribution.md` §3 in the companion hub repo).
 *
 * These are the network-free, filesystem-adjacent pieces: spec parsing, URL
 * building, lockfile read/write, and file installation. The network fetch and
 * arg glue live in `src/cli.ts` (`dispatchAdd`) so this module stays trivially
 * unit-testable and `cli.ts` doesn't widen its export surface just to reuse
 * `Args`/`CliError`/etc.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Max length for an in-archive relative path we are willing to join and write. */
const MAX_ARCHIVE_PATH_LENGTH = 1024;

/**
 * Returns `undefined` if `relPath` is safe to `join()` under a destination
 * directory, else a human-readable reason it must be rejected. This is
 * reject-don't-normalize: a synthetic archive entry like
 * `workflows/../../victim` is refused outright, never canonicalized into a
 * "safe" path. Part of SEC-1 — an unnormalized entry name must never escape
 * the staging or install directory.
 */
export function archivePathViolation(relPath: string): string | undefined {
  if (relPath === '') return 'empty path';
  if (relPath.includes('\0')) return 'contains a NUL byte';
  if (isAbsolute(relPath) || /^[\\/]/.test(relPath) || /^[A-Za-z]:/.test(relPath)) {
    return 'is an absolute path';
  }
  // Split on both separators so '..\\' tricks and doubled separators can't
  // smuggle a traversal segment past the check.
  const segments = relPath.split(/[\\/]+/);
  if (segments.some((s) => s === '.' || s === '..')) {
    return "contains a '.' or '..' segment";
  }
  if (relPath.length > MAX_ARCHIVE_PATH_LENGTH) {
    return `exceeds ${MAX_ARCHIVE_PATH_LENGTH}-char path length limit`;
  }
  return undefined;
}

export interface RepoSpec {
  owner: string;
  repo: string;
  ref: string;
}

/** Parse `owner/repo` or `owner/repo@ref` into its parts; `ref` defaults to `'HEAD'`. */
export function parseRepoSpec(spec: string): RepoSpec {
  const atIdx = spec.lastIndexOf('@');
  const ownerRepo = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
  const ref = atIdx >= 0 ? spec.slice(atIdx + 1) : 'HEAD';
  const slashIdx = ownerRepo.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`malformed repo spec '${spec}' — expected owner/repo[@ref]`);
  }
  const owner = ownerRepo.slice(0, slashIdx);
  const repo = ownerRepo.slice(slashIdx + 1);
  if (!owner || !repo) {
    throw new Error(`malformed repo spec '${spec}' — expected owner/repo[@ref]`);
  }
  if (repo.includes('/')) {
    throw new Error(`malformed repo spec '${spec}' — expected owner/repo[@ref]`);
  }
  if (!ref) {
    throw new Error(`malformed repo spec '${spec}' — empty ref after '@'`);
  }
  return { owner, repo, ref };
}

export function githubShaUrl(owner: string, repo: string, ref: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`;
}

export function githubTarballUrl(owner: string, repo: string, sha: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
}

// ---- lockfile ------------------------------------------------------------

export interface InstalledEntry {
  source: string;
  ref: string;
  sha: string;
  installedAt: number;
  path: string;
  files: string[];
}

export interface Lockfile {
  version: 1;
  installed: Record<string, InstalledEntry>;
}

/** Read `.owenloop/installed.json`; a missing file is an empty lockfile, not an error. */
export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) return { version: 1, installed: {} };
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Lockfile;
}

export function writeLockfile(path: string, lf: Lockfile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lf, null, 2)}\n`);
}

// ---- install ---------------------------------------------------------------

/**
 * Install `files` (relative path → bytes) under `defsDir/folder`, clearing
 * any prior install at that folder first so a re-add is a clean refresh
 * (stale files from a previous version are removed, not just overwritten).
 * Returns the sorted list of relative paths written.
 */
export function installFiles(defsDir: string, folder: string, files: Map<string, Uint8Array>): string[] {
  const target = join(defsDir, folder);
  rmSync(target, { recursive: true, force: true });
  const written: string[] = [];
  for (const [relPath, bytes] of files) {
    // Defense-in-depth: this function is exported and clears/writes whole
    // directories, so it must not trust its caller to have validated keys.
    const violation = archivePathViolation(relPath);
    if (violation) {
      throw new Error(`refusing to write unsafe archive path '${relPath}': ${violation}`);
    }
    const full = join(target, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    written.push(relPath);
  }
  return written.sort();
}
