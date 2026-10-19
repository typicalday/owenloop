import { readContainedFile } from './contained-path.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a submit value from a JSON document contained in a run worktree.
 *
 * Containment and stable file reading are `readContainedFile`'s job.
 * This function owns only what is specific to
 * a submit value: the argument shape and the JSON decode.
 */
export async function readSubmitValueFile(workdir: string, valueFile: unknown): Promise<unknown> {
  if (typeof valueFile !== 'string' || valueFile.trim() === '') {
    throw new Error(`submit-value-file-invalid: valueFile must be a non-empty string: ${String(valueFile)}`);
  }
  const { bytes } = await readContainedFile(workdir, valueFile, 'submit-value-file');
  const text = bytes.toString('utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`submit-value-file-invalid-json: could not parse ${valueFile}: ${errorMessage(error)}`);
  }
}
