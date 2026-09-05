import { readFile } from 'node:fs/promises';

import { resolveContainedPath } from './contained-path.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a submit value from a JSON document contained in a run worktree.
 *
 * Containment is `resolveContainedPath`'s job — lexical traversal check first,
 * then a canonical symlink check. This function owns only what is specific to
 * a submit value: the argument shape and the JSON decode.
 */
export async function readSubmitValueFile(workdir: string, valueFile: unknown): Promise<unknown> {
  if (typeof valueFile !== 'string' || valueFile.trim() === '') {
    throw new Error(`submit-value-file-invalid: valueFile must be a non-empty string: ${String(valueFile)}`);
  }
  const canonicalCandidate = await resolveContainedPath(workdir, valueFile, 'submit-value-file');
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
