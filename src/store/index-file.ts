/**
 * `index.json` — the workflow-store coordinate index, one per store root.
 * Strict fail-closed parsing, canonical serialization, and atomic writes.
 *
 * The index is attacker-influenceable disk input (a project index is ordinary
 * repo content; a global index lives next to user data): every byte read from
 * it passes {@link parseWorkflowStoreIndex} before any consumer acts on it. A
 * malformed index is a hard, named error — never silently reset to empty
 * (which would erase pins) and never normalized (an uppercase digest stays
 * invalid rather than being lowercased into apparent validity).
 */

import { lstatSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { WORKFLOW_NAME_RE } from '../bundle/manifest.ts';
import { DIGEST_RE, StoreIndexError, parseWorkflowCoordinate } from './types.ts';
import type { WorkflowStoreIndex } from './types.ts';
import { readRegularFileNoFollow, writeJsonAtomic } from '../install.ts';

/** The current (and only) index schema version. */
export const WORKFLOW_STORE_INDEX_VERSION = 1;

/** The empty index (what a root with no index file logically holds). */
export function emptyWorkflowStoreIndex(): WorkflowStoreIndex {
  return { version: 1, entries: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structurally validate a parsed `index.json`, fail-closed — the trust
 * boundary for the workflow-store index (same discipline as the GitHub
 * route's `validateLockfile`). EVERY entry is validated, not just one being
 * installed: the writer re-serializes the whole index on success, so acting
 * while carrying a poisoned sibling entry would re-persist it.
 *
 * Enforced: `version === 1`; `entries` a plain object; each key a full
 * `namespace/name@version` coordinate (validated by
 * `parseWorkflowCoordinate`); each entry `{ digest, pinned }` with digest a
 * LOWERCASE 64-hex value (uppercase/noncanonical is rejected, never
 * normalized) and pinned a boolean. When present, `workflows` is a unique,
 * valid, UTF-8-sorted workflow-name array. Unknown extra keys are tolerated
 * for forward compatibility; required fields are enforced. `path` appears
 * only in error messages. Throws {@link StoreIndexError} on any violation.
 */
export function parseWorkflowStoreIndex(parsed: unknown, path: string): WorkflowStoreIndex {
  const fail = (detail: string): never => {
    throw new StoreIndexError(`invalid workflow store index at ${path}: ${detail} — fix or remove it manually`);
  };
  if (!isPlainObject(parsed)) return fail('top-level value is not an object');
  if (parsed.version !== WORKFLOW_STORE_INDEX_VERSION) {
    return fail(`unsupported index version ${JSON.stringify(parsed.version)} (expected 1)`);
  }
  if (!isPlainObject(parsed.entries)) return fail("'entries' is not an object");
  for (const [key, entry] of Object.entries(parsed.entries)) {
    const at = (field: string): string => `entries[${JSON.stringify(key)}].${field}`;
    try {
      parseWorkflowCoordinate(key);
    } catch (e) {
      return fail(`key ${JSON.stringify(key)} is not a valid coordinate: ${(e as Error).message}`);
    }
    if (!isPlainObject(entry)) return fail(`entries[${JSON.stringify(key)}] is not an object`);
    if (typeof entry.digest !== 'string' || !DIGEST_RE.test(entry.digest)) {
      return fail(`${at('digest')} is not a lowercase 64-char sha256 hex digest`);
    }
    if (typeof entry.pinned !== 'boolean') return fail(`${at('pinned')} is not a boolean`);
    if (entry.workflows !== undefined) {
      if (!Array.isArray(entry.workflows) || entry.workflows.some((name) => typeof name !== 'string')) {
        return fail(`${at('workflows')} is not an array of workflow names`);
      }
      for (const [index, name] of entry.workflows.entries()) {
        if (!WORKFLOW_NAME_RE.test(name)) {
          return fail(`${at(`workflows[${index}]`)} is not a valid workflow name`);
        }
      }
      if (new Set(entry.workflows).size !== entry.workflows.length) {
        return fail(`${at('workflows')} contains duplicate workflow names`);
      }
      const sorted = [...entry.workflows].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
      if (entry.workflows.some((name, index) => name !== sorted[index])) {
        return fail(`${at('workflows')} must be sorted by UTF-8 bytes`);
      }
    }
  }
  return parsed as unknown as WorkflowStoreIndex;
}

/**
 * Read `index.json` at a store root; a MISSING file is an empty index, not an
 * error (a root that has never installed anything). A present-but-unparseable
 * file is a hard {@link StoreIndexError}; a parseable-but-invalid file is a
 * hard {@link StoreIndexError} via {@link parseWorkflowStoreIndex}. Never
 * silently resets to empty, never trusts content for filesystem paths.
 *
 * Symlink/type guard: `lstat` (never `stat`) refuses a symlink squatting at
 * the index path — a symlinked index would make reads and the atomic write's
 * rename act through the link, outside the root (SEC-3). A non-regular file
 * (a directory) is refused for the same reason.
 */
export function readWorkflowStoreIndex(path: string): WorkflowStoreIndex {
  let rawBytes: Uint8Array | undefined;
  try {
    rawBytes = readRegularFileNoFollow(path, 'workflow store index');
  } catch (e) {
    throw new StoreIndexError(`refusing workflow store index at ${path}: ${(e as Error).message}`);
  }
  if (rawBytes === undefined) return emptyWorkflowStoreIndex();
  const raw = new TextDecoder().decode(rawBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StoreIndexError(
      `corrupt workflow store index at ${path}: ${(e as Error).message} — fix or remove it manually`,
    );
  }
  return parseWorkflowStoreIndex(parsed, path);
}

/**
 * Serialize an index CANONICALLY (`JSON.stringify(..., null, 2) + '\n'`) and
 * write it atomically (sibling temp file + rename — the shared
 * `writeJsonAtomic` discipline: a crash or concurrent reader never sees a
 * half-written index; a failed rename cleans up its temp and surfaces the
 * original error). Canonical bytes matter twice over: they are what the
 * crash-recovery journal's `metadataHash` commits to, and they make the index
 * diff-stable in git review.
 */
export function serializeWorkflowStoreIndex(index: WorkflowStoreIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * Atomically write `index` to `path` (canonical serialization). Callers hold
 * the root's install lock; the write itself is rename-atomic within the
 * directory. `rm` is injectable for the same double-fault test seam the
 * lockfile writer exposes.
 */
export function writeWorkflowStoreIndex(
  path: string,
  index: WorkflowStoreIndex,
  opts: { rm?: (path: string, opts: { force: true }) => void } = {},
): void {
  // The parent directory must exist and be a real directory — a symlinked
  // parent would redirect the atomic rename outside the root.
  const parent = dirname(path);
  const parentSt = lstatSync(parent, { throwIfNoEntry: false });
  if (parentSt?.isSymbolicLink()) {
    throw new StoreIndexError(`refusing to write workflow store index: parent '${parent}' is a symlink`);
  }
  writeJsonAtomic(path, index, opts);
}

/** Remove a stray temp sibling (best-effort; absence is fine). */
export function removeIndexTempSibling(path: string): void {
  rmSync(path, { force: true });
}
