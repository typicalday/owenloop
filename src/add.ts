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
import { dirname, join } from 'node:path';

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
    const full = join(target, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    written.push(relPath);
  }
  return written.sort();
}
