import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isInside } from './harness/gatekeeper.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a submit value from a JSON document contained in a run worktree.
 *
 * The lexical check rejects traversal before probing the filesystem. The
 * canonical check rejects symlinks whose target leaves the worktree.
 */
export async function readSubmitValueFile(workdir: string, valueFile: unknown): Promise<unknown> {
  if (typeof valueFile !== 'string' || valueFile.trim() === '') {
    throw new Error(`submit-value-file-invalid: valueFile must be a non-empty string: ${String(valueFile)}`);
  }

  const candidate = resolve(workdir, valueFile);
  if (!isInside(workdir, candidate)) {
    throw new Error(`submit-value-file-outside-workdir: ${valueFile} is outside the run workdir`);
  }

  let canonicalCandidate: string;
  try {
    const canonicalWorkdir = await realpath(workdir);
    canonicalCandidate = await realpath(candidate);
    if (!isInside(canonicalWorkdir, canonicalCandidate)) {
      throw new Error(`submit-value-file-outside-workdir: ${valueFile} is outside the run workdir`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('submit-value-file-outside-workdir:')) throw error;
    throw new Error(`submit-value-file-read-failed: could not read ${valueFile}: ${errorMessage(error)}`);
  }

  let text: string;
  try {
    text = await readFile(canonicalCandidate, 'utf8');
  } catch (error) {
    throw new Error(`submit-value-file-read-failed: could not read ${valueFile}: ${errorMessage(error)}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`submit-value-file-invalid-json: could not parse ${valueFile}: ${errorMessage(error)}`);
  }
}
